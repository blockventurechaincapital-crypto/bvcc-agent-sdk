/**
 * Capability catalog — the single, declarative list of everything an AI runtime
 * is allowed to invoke on a BVCC Agent Wallet through this SDK.
 *
 * Why this exists: each AI runtime speaks a different dialect. MCP clients
 * (Claude Code, Cursor, Claude app) want MCP tools; OpenClaw wants a Skill;
 * ElizaOS wants a plugin. Instead of re-describing every action once per runtime,
 * every wrapper reads THIS list and generates its own tools from it. Add an
 * action here once → every wrapper gets it.
 *
 * Security model (read this before adding anything):
 *  - This catalog adds NO powers. Every limit (spend caps, allowed tokens,
 *    allowed protocols, recipient whitelist, pause) is enforced on-chain by the
 *    Agent Wallet contract. The worst an exposed action can do is bounded by
 *    what the user authorized for that agent in the dashboard.
 *  - Exposure is EXPLICIT: an action is reachable only if it has an entry here.
 *    Nothing is auto-discovered from the client. Keep this list deliberate.
 *  - `kind` lets a wrapper gate by class — e.g. a read-only MCP exposes only
 *    `read`, or a wrapper asks for confirmation before any `write`. It is a
 *    convenience label, NOT the security boundary (the contract is).
 *
 * Amounts are human-readable decimal strings ("0.1"); the catalog resolves token
 * decimals and converts to base units. Tokens accept a symbol ("USDC") or a 0x
 * address.
 */
import { UINT128_MAX } from "./v5.js";
import { formatUnits, isAddress, parseEther, parseUnits, type Address } from "viem";
import { z } from "zod";
import { erc20Abi } from "./abi.js";
import type { BvccAgentClient } from "./client.js";
import { resolveToken, NATIVE_TOKEN } from "./tokens.js";
import { netOfFee } from "./nativeSwap.js";
import { PERMIT2 } from "./universalRouter.js";
import { listGuides as guideList, getGuide as guideText } from "./guides.js";

/** What class of operation a capability performs. */
export type CapabilityKind = "read" | "write" | "simulate";

/** A single declarative capability. Wrappers read this to build their tools. */
export interface Capability<A = unknown> {
  /** Stable identifier (matches `ActionName` where applicable). */
  id: string;
  /** read = no tx; write = broadcasts a tx; simulate = previews without sending. */
  kind: CapabilityKind;
  /** Short human title. */
  title: string;
  /** One line for tool selection by the model. */
  summary: string;
  /** Fuller description, including on-chain requirements/caveats. */
  description: string;
  /** Zod schema: validates the model's args AND describes them to wrappers. */
  params: z.ZodType<A>;
  /**
   * Feature group this belongs to. Wrappers can switch whole groups off — an
   * operator who only wants transfers and swaps should not have to hand an agent
   * a lending surface it will never use. Defaults to "core".
   */
  module?: CapabilityModule;
  /** Invoke against a live client. Returns whatever the underlying method returns. */
  invoke: (client: BvccAgentClient, args: A) => Promise<unknown>;
}

/**
 * Feature groups a wrapper can enable or disable wholesale. `meta` is special:
 * help/navigation (the guides) that is ALWAYS exposed, never gated by a module
 * filter — an agent restricted to one feature must still be able to read how to
 * use it.
 */
export type CapabilityModule = "core" | "aave" | "lp" | "meta";

/** The user-selectable feature groups (meta is always-on, so it is not listed). */
export const CAPABILITY_MODULES: readonly CapabilityModule[] = ["core", "aave", "lp"] as const;

/**
 * Filter the catalog down to the requested modules.
 *
 * Reducing what an agent can reach is a real safety lever: fewer exposed actions
 * means fewer ways a confused or compromised agent can act, even though the
 * contract remains the actual boundary. An unknown module name is ignored rather
 * than throwing, so a typo degrades to a smaller surface, never a larger one.
 */
export function filterByModules(
  capabilities: readonly Capability<never>[],
  modules: readonly string[],
): readonly Capability<never>[] {
  const wanted = new Set(modules.map((m) => m.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return capabilities;
  return capabilities.filter((c) => {
    const m = c.module ?? "core";
    return m === "meta" || wanted.has(m); // meta (help) is always exposed
  });
}

// ---------------------------------------------------------------------------
// Reusable param pieces
// ---------------------------------------------------------------------------

const zAddress = z
  .string()
  .refine((s) => isAddress(s), "must be a 0x-prefixed address")
  .describe("A 0x-prefixed EVM address");

const zToken = z
  .string()
  .min(1)
  .describe('Token symbol (e.g. "USDC") or a 0x address');

const zAmount = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "must be a positive decimal like '0.1'")
  .describe("Human-readable amount as a decimal string, e.g. '0.1'");

const zTokenId = z
  .string()
  .regex(/^\d+$/, "must be an integer tokenId as a string")
  .describe("Uniswap v3 position NFT id (integer as a string, e.g. '123456')");

/**
 * Reject a fund-moving swap with no slippage floor. `amountOutMinimum` of 0 means
 * "accept any output" — a sandwich/MEV bot can take almost everything. Callers
 * should quote first (buildSwapPlan) and pass a real minimum. Dry-runs are exempt
 * (they move nothing), so this guard lives only on the write swaps.
 */
function requireSlippageProtection(amountOutMinimumRaw: bigint): void {
  if (amountOutMinimumRaw <= 0n) {
    throw new Error(
      "amountOutMinimum is 0 — refusing to swap without slippage protection. " +
        "Call buildSwapPlan (quote:true) to get a minimum, then pass it.",
    );
  }
}

/**
 * Resolve the minimum-output floor for a WRITE swap, enforcing slippage protection.
 * Priority: explicit `amountOutMinimum` → else derive from `slippageBps` via an
 * on-chain quote → else refuse. Returns the resolved tokenOut address and the raw
 * minimum to pass to the swap.
 */
async function deriveMinOut(
  client: BvccAgentClient,
  protocol: "v3" | "v4",
  p: {
    tokenIn: string;
    tokenOut: string;
    amountInRaw: bigint;
    amountOutMinimum?: string;
    slippageBps?: number;
    fee?: number;
    tickSpacing?: number;
  },
): Promise<{ outAddress: Address; minRaw: bigint }> {
  if (p.amountOutMinimum != null) {
    const out = await toBaseUnits(client, p.tokenOut, p.amountOutMinimum);
    requireSlippageProtection(out.raw);
    return { outAddress: out.address, minRaw: out.raw };
  }
  if (p.slippageBps != null) {
    const plan = await client.buildSwapPlan({
      protocol,
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      amountIn: p.amountInRaw,
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      quote: true,
      slippageBps: p.slippageBps,
    });
    if (plan.amountOutMinimum == null) {
      throw new Error(
        "Could not quote to derive amountOutMinimum from slippageBps (no quote available). Pass amountOutMinimum explicitly.",
      );
    }
    // For a v4 swap, the plan may have fallen back to a v3 pool as a *price proxy*
    // when the v4 quoter was unavailable. Deriving a slippage floor from a
    // different pool can under-protect the swap — refuse silent derivation and
    // make the caller confirm an explicit minimum.
    if (plan.warnings.some((w) => w.toLowerCase().includes("price proxy"))) {
      throw new Error(
        "amountOutMinimum could not be quoted from the v4 pool (the v4 quoter was unavailable, " +
          "so the price came from a v3 pool as a proxy). Deriving slippage from a different pool is " +
          "unsafe — pass amountOutMinimum explicitly for this swap.",
      );
    }
    requireSlippageProtection(plan.amountOutMinimum);
    return { outAddress: plan.tokenOut, minRaw: plan.amountOutMinimum };
  }
  throw new Error(
    "Provide amountOutMinimum (exact) or slippageBps (e.g. 50 = 0.5%, 100 = 1%) so the swap has slippage protection.",
  );
}

/** Resolve a token symbol/address + human amount to `{ address, raw }` base units. */
async function toBaseUnits(
  client: BvccAgentClient,
  token: string,
  human: string,
): Promise<{ address: Address; raw: bigint }> {
  const resolved = resolveToken(client.network.chainId, token);
  let decimals = resolved.decimals;
  if (decimals == null) {
    try {
      decimals = Number(
        await client.publicClient.readContract({
          address: resolved.address,
          abi: erc20Abi,
          functionName: "decimals",
        }),
      );
    } catch {
      // Do NOT assume 18 here: this converts a human amount into base units that
      // can be broadcast. Guessing the scale could send 1e12x the intended amount.
      // Refuse and make the caller pass a known token / address instead.
      throw new Error(
        `Could not read decimals for token ${resolved.address} — refusing to convert the amount ` +
          `without a verified decimals value. Use a known token symbol or check the address/RPC.`,
      );
    }
  }
  return { address: resolved.address, raw: parseUnits(human, decimals) };
}

/** Resolve a token's decimals and symbol (registry first, on-chain fallback). */
async function tokenMeta(
  client: BvccAgentClient,
  address: Address,
): Promise<{ decimals: number; symbol: string }> {
  const resolved = resolveToken(client.network.chainId, address);
  let decimals = resolved.decimals;
  let symbol = resolved.symbol;
  if (decimals == null) {
    try {
      decimals = Number(
        await client.publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      );
    } catch {
      decimals = 18;
    }
  }
  if (symbol == null) {
    try {
      symbol = (await client.publicClient.readContract({
        address,
        abi: erc20Abi,
        functionName: "symbol",
      })) as string;
    } catch {
      symbol = `${address.slice(0, 6)}…${address.slice(-4)}`;
    }
  }
  return { decimals, symbol };
}

// ---------------------------------------------------------------------------
// Human-readable formatting for reads that return raw base-unit amounts.
// Small LLMs reliably misconvert wei → decimal; surfacing a `formatted` string
// next to the raw value removes that failure mode. Semantics matter:
//   - cap/limit/budget fields: 0 (or null) means UNLIMITED before V5; on V5, 0 means
//     NOT ALLOWED and only null / type(uint128).max is unlimited.
//   - remaining fields: null means UNLIMITED, 0 means EXHAUSTED ("0").
//   - spent fields: always a literal amount.
// ---------------------------------------------------------------------------

/**
 * A cap/limit/budget. Before V5, 0 or null renders as "unlimited". On wallet V5,
 * 0 means nothing is allowed and only null / type(uint128).max is unlimited.
 */
function fmtCap(raw: bigint | null, decimals: number, symbol: string, v5 = false): string {
  if (v5) {
    if (raw == null || raw === UINT128_MAX) return "unlimited";
    if (raw === 0n) return `not allowed (0 ${symbol})`;
    return `${formatUnits(raw, decimals)} ${symbol}`;
  }
  if (raw == null || raw === 0n) return "unlimited";
  return `${formatUnits(raw, decimals)} ${symbol}`;
}

/** Remaining headroom: null = unlimited, 0 = exhausted (shown as "0 SYMBOL"). */
function fmtRemaining(raw: bigint | null, decimals: number, symbol: string): string {
  if (raw == null) return "unlimited";
  return `${formatUnits(raw, decimals)} ${symbol}`;
}

/** A literal amount (e.g. spent). */
function fmtAmount(raw: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(raw, decimals)} ${symbol}`;
}

/** Render a duration in seconds as a short human string ("1h 30m"). */
function fmtDuration(seconds: bigint | null): string | null {
  if (seconds == null) return null;
  let s = Number(seconds);
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return `in ${parts.join(" ")}`;
}

/** Add a `formatted` block (network fee in the chain's currency) to a dry-run. */
function enrichDryRun(
  client: BvccAgentClient,
  r: { estimatedGas: bigint | null; estimatedNetworkFeeWei: bigint | null },
): unknown {
  const cur = client.network.currency;
  return {
    ...r,
    formatted: {
      estimatedGas: r.estimatedGas == null ? null : r.estimatedGas.toString(),
      estimatedNetworkFee:
        r.estimatedNetworkFeeWei == null ? null : `${formatUnits(r.estimatedNetworkFeeWei, 18)} ${cur}`,
    },
  };
}

/** Human label for a known protocol address (router / Permit2), else short hex. */
function labelProtocol(client: BvccAgentClient, address: Address): string {
  const a = address.toLowerCase();
  if (a === PERMIT2.toLowerCase()) return "Uniswap Permit2";
  if (a === client.network.universalRouter?.toLowerCase()) return "Uniswap Universal Router";
  if (a === client.network.swapRouter02?.toLowerCase()) return "Uniswap v3 SwapRouter02";
  return `${address.slice(0, 6)}…${address.slice(-4)} (unknown)`;
}

// ---------------------------------------------------------------------------
// Capability definitions
// ---------------------------------------------------------------------------

const sendNative: Capability<{ to: string; amount: string }> = {
  id: "sendNative",
  kind: "write",
  title: "Send native currency",
  summary: "Send ETH/BNB from the wallet to an address.",
  description:
    "Transfers the network's native currency (ETH on Arbitrum/Ethereum/Base, BNB on BNB Chain) " +
    "from the Agent Wallet to `to`. Subject to the agent's on-chain spend limits and recipient " +
    "whitelist; reverts on-chain if over budget or the recipient is not allowed.",
  params: z.object({ to: zAddress, amount: zAmount }),
  invoke: (client, { to, amount }) =>
    client.sendNative(to as Address, parseEther(amount)),
};

const sendToken: Capability<{ token: string; to: string; amount: string }> = {
  id: "sendToken",
  kind: "write",
  title: "Send an ERC-20 token",
  summary: "Transfer an ERC-20 token from the wallet to an address.",
  description:
    "Transfers `amount` of `token` to `to`. `token` must be in the agent's allowedTokens and " +
    "the amount within its per-token daily/total budget, both enforced on-chain.",
  params: z.object({ token: zToken, to: zAddress, amount: zAmount }),
  invoke: async (client, { token, to, amount }) => {
    const { address, raw } = await toBaseUnits(client, token, amount);
    return client.sendToken(address, to as Address, raw);
  },
};

const approve: Capability<{ token: string; spender: string; amount: string }> = {
  id: "approve",
  kind: "write",
  title: "Approve a spender",
  summary: "Grant an ERC-20 allowance to a spender (counts toward the token budget).",
  description:
    "Wallet V5: the spender must be one of the agent's allowed protocols, and the allowance is reset to zero when the batch ends. " +
    "Approves `spender` to move up to `amount` of `token`. The approved amount counts toward the " +
    "agent's on-chain token budget (anti cap-bypass). Prefer exact amounts over unlimited approvals.",
  params: z.object({ token: zToken, spender: zAddress, amount: zAmount }),
  invoke: async (client, { token, spender, amount }) => {
    const { address, raw } = await toBaseUnits(client, token, amount);
    return client.approve(address, spender as Address, raw);
  },
};

/**
 * Shared swap input shape (single-hop). Slippage protection is required for the
 * write swaps: pass EITHER `amountOutMinimum` (an exact floor in tokenOut units)
 * OR `slippageBps` (tolerance — the tool quotes on-chain and derives the floor).
 * If both are given, `amountOutMinimum` wins. Neither → the swap is refused.
 */
const swapParams = z.object({
  tokenIn: zToken,
  tokenOut: zToken,
  amountIn: zAmount,
  amountOutMinimum: zAmount
    .optional()
    .describe(
      "Exact minimum output (in tokenOut units). Provide this OR slippageBps. Takes precedence if both set. '0' is refused.",
    ),
  slippageBps: z
    .number()
    .int()
    .optional()
    .describe(
      "Slippage tolerance in basis points (50 = 0.5%, 100 = 1%). Used to derive amountOutMinimum from an on-chain quote when amountOutMinimum is not given.",
    ),
  fee: z
    .number()
    .int()
    .optional()
    .describe("Pool fee tier (e.g. 100, 500, 3000). Default 3000."),
});
type SwapArgs = z.infer<typeof swapParams>;

const swapV3: Capability<SwapArgs> = {
  id: "swapV3",
  kind: "write",
  title: "Swap on Uniswap v3 (SwapRouter02)",
  summary: "Exact-input swap of one ERC-20 for another via Uniswap v3.",
  description:
    "Wallet V5: SwapRouter02 is not available to agents there; the client sends this same swap through the Universal Router automatically, pulling through the owner's Permit2 allowance. " +
    "Atomic approve + exactInputSingle on the network's SwapRouter02. Output is returned to the " +
    "wallet. Requires the router in allowedProtocols and `tokenIn` in allowedTokens. ERC-20 in/out only. " +
    "Pass `amountOutMinimum` (exact) or `slippageBps` (e.g. 50 = 0.5%, 100 = 1%); one is required.",
  params: swapParams,
  invoke: async (client, p) => {
    const inUnits = await toBaseUnits(client, p.tokenIn, p.amountIn);
    const { outAddress, minRaw } = await deriveMinOut(client, "v3", {
      ...p,
      amountInRaw: inUnits.raw,
    });
    return client.swapExactInputV3({
      tokenIn: inUnits.address,
      tokenOut: outAddress,
      amountIn: inUnits.raw,
      amountOutMinimum: minRaw,
      fee: p.fee,
    });
  },
};

const swapV4Params = swapParams.extend({
  tickSpacing: z
    .number()
    .int()
    .optional()
    .describe("v4 pool tick spacing (e.g. 10 for the 0.05% USDC/WETH pool). Default 60."),
  nativeOut: z
    .boolean()
    .optional()
    .describe(
      "Deliver native ETH via the v4 native (address(0)) pool — output goes straight to the wallet. " +
        "`tokenOut` is ignored; pass the native pool's fee/tickSpacing (e.g. 500/10 for ETH/USDC 0.05%).",
    ),
});
type SwapV4Args = z.infer<typeof swapV4Params>;

const swapV4: Capability<SwapV4Args> = {
  id: "swapV4",
  kind: "write",
  title: "Swap on Uniswap v4 (Universal Router + Permit2)",
  summary: "Exact-input swap via Uniswap v4 pools through the Universal Router.",
  description:
    "Wallet V5: Permit2 is granted by the owner, so the agent only needs the Universal Router allowed; v4 pools with a hook work only if the hook is approved. " +
    "Permit2-funded v4 swap through the Universal Router — byte-compatible with app.uniswap.org. " +
    "Reaches liquidity living on v4 pools (identified by fee + tickSpacing). Requires BOTH the " +
    "Universal Router and Permit2 in allowedProtocols, and `tokenIn` in allowedTokens. " +
    "Pass `amountOutMinimum` (exact) or `slippageBps` (e.g. 50 = 0.5%, 100 = 1%); one is required.",
  params: swapV4Params,
  invoke: async (client, p) => {
    const inUnits = await toBaseUnits(client, p.tokenIn, p.amountIn);
    // Native output prices and settles on the native (address(0)) pool, not WETH —
    // quote and floor come from that pool so slippage protection matches the swap.
    const tokenOut = p.nativeOut ? NATIVE_TOKEN : p.tokenOut;
    const { outAddress, minRaw } = await deriveMinOut(client, "v4", {
      ...p,
      tokenOut,
      amountInRaw: inUnits.raw,
    });
    return client.swapV4ExactIn({
      tokenIn: inUnits.address,
      tokenOut: outAddress,
      amountIn: inUnits.raw,
      amountOutMinimum: minRaw,
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      nativeOut: p.nativeOut,
    });
  },
};

// --- Reads ----------------------------------------------------------------

const getAgentStatus: Capability<Record<string, never>> = {
  id: "getAgentStatus",
  kind: "read",
  title: "Get agent status",
  summary: "Snapshot of the agent's on-chain authorization (active, expiry, whitelists).",
  description:
    "Reads whether the agent is authorized/expired/paused, its expiry, and the allowed tokens, " +
    "protocols and recipients. Use to understand what the agent may do before acting.",
  params: z.object({}),
  invoke: async (client) => {
    const s = await client.getAgentStatus();
    return {
      ...s,
      // Surface a readable expiry; raw `expiry` (unix seconds, 0 = never) kept.
      expiryHuman: s.expiry === 0n ? "never" : new Date(Number(s.expiry) * 1000).toISOString(),
      // Onboarding: not authorized → how to set up; authorized → point at the guides.
      ...(s.isAuthorized
        ? {
            hint:
              "New to this wallet? Call getGuide('getting-started') for the safe operating loop; " +
              "listGuides shows the guides for swaps, lending and liquidity.",
          }
        : {
            suggestedAction:
              "This agent is not authorized on this wallet/chain. Create a BVCC Agent Wallet " +
              "and authorize this agent's address at https://bvccwallet.blockventurechaincapital.com, " +
              "then retry. Once authorized, call getGuide('getting-started') to learn the operating loop.",
          }),
    };
  },
};

const getCapabilities: Capability<Record<string, never>> = {
  id: "getCapabilities",
  kind: "read",
  title: "Get agent capabilities",
  summary: "Derived booleans: can this agent send / approve / swap right now, and why not.",
  description:
    "Derives canSendNative/canSendTokens/canApprove/canSwapV3/canSwapV4 from the live on-chain " +
    "permission, plus human-readable `notes` explaining any blockers (expired, paused, missing whitelist).",
  params: z.object({}),
  invoke: (client) => client.getCapabilities(),
};

const getNativeBalance: Capability<Record<string, never>> = {
  id: "getNativeBalance",
  kind: "read",
  title: "Get native balance",
  summary: "The wallet's native (ETH/BNB) balance.",
  description: "Reads the Agent Wallet's native currency balance, formatted and raw.",
  params: z.object({}),
  invoke: async (client) => {
    const b = await client.getNativeBalance();
    // formatted carries the symbol so small models don't read the raw base-unit field
    return { ...b, formatted: `${b.formatted} ${b.symbol}` };
  },
};

const getTokenBalances: Capability<{ tokens: string[] }> = {
  id: "getTokenBalances",
  kind: "read",
  title: "Get token balances",
  summary: "The wallet's balances for a list of ERC-20 tokens.",
  description:
    "Reads balances for the given tokens (symbols or addresses), each with symbol, decimals, " +
    "raw and formatted amounts.",
  params: z.object({
    tokens: z.array(zToken).min(1).describe("Token symbols or addresses to read."),
  }),
  invoke: async (client, { tokens }) => {
    const list = await client.getBalances(tokens);
    // formatted carries the symbol so small models don't read the raw base-unit field
    return list.map((b) => ({ ...b, formatted: `${b.formatted} ${b.symbol}` }));
  },
};

const getRemaining: Capability<Record<string, never>> = {
  id: "getRemaining",
  kind: "read",
  title: "Get remaining budget",
  summary: "Live remaining headroom across every spend limit (null = unlimited).",
  description:
    "Computes remaining native/period/per-token headroom from live on-chain spend. A null field " +
    "means that limit is unlimited. On wallet V5 a 0 limit means not allowed (shown as such), and " +
    "limits are checked on the amount plus a small on-chain charge, so stay a little under them.",
  params: z.object({}),
  invoke: async (client) => {
    const r = await client.getRemaining();
    const v5 = (await client.walletVersion()) === "v5";
    const cur = client.network.currency;
    const tokens = await Promise.all(
      r.tokens.map(async (t) => {
        const { decimals, symbol } = await tokenMeta(client, t.token);
        return {
          ...t,
          symbol,
          decimals,
          formatted: {
            maxPerTx: fmtCap(t.maxPerTx, decimals, symbol, v5),
            dailyLimit: fmtCap(t.dailyLimit, decimals, symbol, v5),
            totalBudget: fmtCap(t.totalBudget, decimals, symbol, v5),
            dailySpent: fmtAmount(t.dailySpent, decimals, symbol),
            totalSpent: fmtAmount(t.totalSpent, decimals, symbol),
            dailyRemaining: fmtRemaining(t.dailyRemaining, decimals, symbol),
            totalRemaining: fmtRemaining(t.totalRemaining, decimals, symbol),
          },
        };
      }),
    );
    return {
      ...r,
      currency: cur,
      formatted: {
        maxPerTx: fmtCap(r.maxPerTxWei, 18, cur, v5),
        dailyRemaining: fmtRemaining(r.dailyRemainingWei, 18, cur),
        totalRemaining: fmtRemaining(r.totalRemainingWei, 18, cur),
        periodRemaining: fmtRemaining(r.periodRemainingWei, 18, cur),
        periodResetsIn: fmtDuration(r.periodResetsInSeconds),
      },
      tokens,
    };
  },
};

const needsApproval: Capability<{
  token: string;
  spender: string;
  amount: string;
  viaPermit2?: boolean;
}> = {
  id: "needsApproval",
  kind: "read",
  title: "Check if approval is needed",
  summary: "Whether `spender` still needs an approval to move `amount` of `token`.",
  description:
    "Wallet V5: Permit2 allowances are the owner's \u2014 if one is missing, ask the owner to renew the agent rather than approving. " +
    "Reads current allowances and returns true if an approve is required before `spender` can move " +
    "`amount`. For Universal Router / v4 swaps pass `viaPermit2: true` (checks ERC-20→Permit2 and " +
    "Permit2→router).",
  params: z.object({
    token: zToken,
    spender: zAddress,
    amount: zAmount,
    viaPermit2: z.boolean().optional(),
  }),
  invoke: async (client, { token, spender, amount, viaPermit2 }) => {
    const { address, raw } = await toBaseUnits(client, token, amount);
    return client.needsApproval(address, spender as Address, raw, { viaPermit2 });
  },
};

// --- Simulate (preview, never broadcasts) ---------------------------------

const swapPlanParams = z.object({
  protocol: z.enum(["v3", "v4"]).describe("Which Uniswap version to route through."),
  tokenIn: zToken,
  tokenOut: zToken,
  amountIn: zAmount,
  fee: z.number().int().optional().describe("Pool fee tier. Default 3000."),
  tickSpacing: z.number().int().optional().describe("v4 tick spacing. Default 60."),
  quote: z.boolean().optional().describe("Quote on-chain to fill amountOutMinimum. Default false."),
  slippageBps: z.number().int().optional().describe("Slippage in basis points for the quote. Default 50 (0.5%)."),
});
type SwapPlanArgs = z.infer<typeof swapPlanParams>;

const buildSwapPlan: Capability<SwapPlanArgs> = {
  id: "buildSwapPlan",
  kind: "simulate",
  title: "Plan a swap (no broadcast)",
  summary: "Resolve a swap: required protocols/tokens, whether an approval is needed, warnings.",
  description:
    "Builds a swap plan without sending anything: resolves the required protocols/tokens, whether " +
    "an approval is needed, and warnings (protocol/token not whitelisted, no min set). With " +
    "`quote: true` it fills amountOutMinimum from the on-chain Quoter. Never throws on read failures.",
  params: swapPlanParams,
  invoke: async (client, p) => {
    const inAmt = await toBaseUnits(client, p.tokenIn, p.amountIn);
    const plan = await client.buildSwapPlan({
      protocol: p.protocol,
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      amountIn: inAmt.raw,
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      quote: p.quote,
      slippageBps: p.slippageBps,
    });
    const inMeta = await tokenMeta(client, plan.tokenIn);
    const outMeta = await tokenMeta(client, plan.tokenOut);
    return {
      ...plan,
      formatted: {
        tokenIn: inMeta.symbol,
        tokenOut: outMeta.symbol,
        amountIn: fmtAmount(plan.amountIn, inMeta.decimals, inMeta.symbol),
        amountOutMinimum:
          plan.amountOutMinimum == null
            ? null
            : fmtAmount(plan.amountOutMinimum, outMeta.decimals, outMeta.symbol),
        requiredProtocols: plan.requiredProtocols.map((a) => ({
          address: a,
          name: labelProtocol(client, a),
        })),
      },
    };
  },
};

const dryRunSendNative: Capability<{ to: string; amount: string }> = {
  id: "dryRunSendNative",
  kind: "simulate",
  title: "Dry-run send native",
  summary: "Simulate a native transfer (gas estimate + revert reason) without sending.",
  description: "Same inputs as sendNative, but only simulates — estimates gas and explains any revert.",
  params: z.object({ to: zAddress, amount: zAmount }),
  invoke: async (client, { to, amount }) =>
    enrichDryRun(client, await client.dryRunSendNative(to as Address, parseEther(amount))),
};

const dryRunSendToken: Capability<{ token: string; to: string; amount: string }> = {
  id: "dryRunSendToken",
  kind: "simulate",
  title: "Dry-run send token",
  summary: "Simulate an ERC-20 transfer (gas estimate + revert reason) without sending.",
  description: "Same inputs as sendToken, but only simulates — estimates gas and explains any revert.",
  params: z.object({ token: zToken, to: zAddress, amount: zAmount }),
  invoke: async (client, { token, to, amount }) => {
    const { address, raw } = await toBaseUnits(client, token, amount);
    return enrichDryRun(client, await client.dryRunSendToken(address, to as Address, raw));
  },
};

const dryRunSwapV3: Capability<SwapArgs> = {
  id: "dryRunSwapV3",
  kind: "simulate",
  title: "Dry-run Uniswap v3 swap",
  summary: "Simulate a v3 swap (gas estimate + revert reason) without sending.",
  description: "Same inputs as swapV3, but only simulates — estimates gas and explains any revert.",
  params: swapParams,
  invoke: async (client, p) => {
    const inUnits = await toBaseUnits(client, p.tokenIn, p.amountIn);
    const outUnits = await toBaseUnits(client, p.tokenOut, p.amountOutMinimum ?? "0");
    return enrichDryRun(
      client,
      await client.dryRunSwapV3({
        tokenIn: inUnits.address,
        tokenOut: outUnits.address,
        amountIn: inUnits.raw,
        amountOutMinimum: outUnits.raw,
        fee: p.fee,
      }),
    );
  },
};

const dryRunSwapV4: Capability<SwapV4Args> = {
  id: "dryRunSwapV4",
  kind: "simulate",
  title: "Dry-run Uniswap v4 swap",
  summary: "Simulate a v4 swap (gas estimate + revert reason) without sending.",
  description: "Same inputs as swapV4, but only simulates — estimates gas and explains any revert.",
  params: swapV4Params,
  invoke: async (client, p) => {
    const inUnits = await toBaseUnits(client, p.tokenIn, p.amountIn);
    const outUnits = await toBaseUnits(client, p.tokenOut, p.amountOutMinimum ?? "0");
    return enrichDryRun(
      client,
      await client.dryRunSwapV4({
        tokenIn: inUnits.address,
        tokenOut: outUnits.address,
        amountIn: inUnits.raw,
        amountOutMinimum: outUnits.raw,
        fee: p.fee,
        tickSpacing: p.tickSpacing,
        nativeOut: p.nativeOut,
      }),
    );
  },
};

/**
 * The full catalog. Order is stable and intentional: reads, simulations, writes.
 * Wrappers should iterate this; filter by `kind` to gate exposure.
 */
// ---------------------------------------------------------------------------
// Native ETH swaps (own batches via SwapRouter02 + WETH)
// ---------------------------------------------------------------------------
// Deliberately NOT the Universal Router's native legs: those park the output in
// the router (ADDRESS_THIS), which the V3 validator denies because anyone could
// sweep it. These batches keep every recipient as the wallet.

const swapToNative: Capability<{
  tokenIn: string;
  amountOut: string;
  amountInMaximum: string;
  fee?: number;
}> = {
  id: "swapToNative",
  kind: "write",
  title: "Swap a token for native ETH",
  summary: "Sell a token and receive native ETH in the wallet (one 0.15% fee).",
  description:
    "Wallet V5: works where the wrapped-native validator is active and the owner allowed it for this agent (getCapabilities \u2192 canWrapNative); otherwise swap to WETH. " +
    "Atomic batch: approve → exact-output swap to WETH (recipient = wallet) → unwrap to ETH. " +
    "Exact-output means you get precisely `amountOut` ETH with no leftover WETH dust, and only " +
    "ONE 0.15% fee is charged. " +
    "`amountInMaximum` is your price protection — it caps what the swap may spend. " +
    "Note the per-token per-tx limit is consumed by that cap, not by what is actually spent, " +
    "so the agent needs headroom of at least `amountInMaximum`. " +
    "Requires WETH in allowedProtocols and `tokenIn` in allowedTokens.",
  params: z.object({
    tokenIn: zToken,
    amountOut: zAmount.describe("Exact native ETH to receive, e.g. '0.01'"),
    amountInMaximum: zAmount.describe("Max of tokenIn to spend — this is the price protection"),
    fee: z.number().int().optional().describe("Pool fee tier. Default 3000."),
  }),
  invoke: async (client, p) => {
    const inUnits = await toBaseUnits(client, p.tokenIn, p.amountInMaximum);
    if (inUnits.raw <= 0n) {
      throw new Error("amountInMaximum must be greater than 0 — it is the swap's price protection.");
    }
    return client.swapToNative({
      tokenIn: inUnits.address,
      amountOut: parseEther(p.amountOut),
      amountInMaximum: inUnits.raw,
      fee: p.fee,
    });
  },
};

const swapFromNative: Capability<{
  tokenOut: string;
  amountIn: string;
  amountOutMinimum?: string;
  slippageBps?: number;
  fee?: number;
}> = {
  id: "swapFromNative",
  kind: "write",
  title: "Swap native ETH for a token",
  summary: "Spend native ETH to buy a token. The 0.15% agent fee applies.",
  description:
    "Wallet V5: works where the wrapped-native validator is active and the owner allowed it for this agent (getCapabilities \u2192 canWrapNative); otherwise swap from WETH. " +
    "Atomic batch: wrap ETH to WETH → approve → swap to `tokenOut` (recipient = wallet). " +
    "The 0.15% agent fee applies. The swap is sized to the post-fee WETH automatically. " +
    "Requires WETH in allowedProtocols and allowedTokens. " +
    "Pass `amountOutMinimum` (exact) or `slippageBps`; one is required.",
  params: z.object({
    tokenOut: zToken,
    amountIn: zAmount.describe("Native ETH to spend, e.g. '0.01'"),
    amountOutMinimum: zAmount
      .optional()
      .describe("Exact minimum output in tokenOut units. Provide this OR slippageBps. '0' is refused."),
    slippageBps: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Slippage tolerance in basis points (50 = 0.5%). Quoted against the post-fee WETH.",
      ),
    fee: z.number().int().optional().describe("Pool fee tier. Default 3000."),
  }),
  invoke: async (client, p) => {
    const weth = client.network.weth;
    if (!weth) throw new Error(`No WETH address known for ${client.network.name}.`);
    const amountInRaw = parseEther(p.amountIn);
    // Quote against the amount that actually reaches the pool: the wrap's 0.15%
    // fee is taken first, so quoting the gross ETH would set the floor too high.
    const { minRaw } = await deriveMinOut(client, "v3", {
      tokenIn: weth,
      tokenOut: p.tokenOut,
      amountInRaw: netOfFee(amountInRaw),
      amountOutMinimum: p.amountOutMinimum,
      slippageBps: p.slippageBps,
      fee: p.fee,
    });
    const out = resolveToken(client.network.chainId, p.tokenOut);
    return client.swapFromNative({
      tokenOut: out.address,
      amountIn: amountInRaw,
      amountOutMinimum: minRaw,
      fee: p.fee,
    });
  },
};

// ---------------------------------------------------------------------------
// Aave v3 — lending (reads, writes, dry-runs)
// ---------------------------------------------------------------------------
// Writes reach the Pool through the agent's call policies, which pin the
// beneficiary to the wallet, so none of these take a `to`/`onBehalfOf`. The Pool
// must be in allowedProtocols; the leading approve on supply/repay is Case 2b, so
// if a recipient whitelist is set the Pool must be in it too.

const zAaveAmount = zAmount.describe('Human amount, e.g. "0.5"');
const zAaveAmountOrMax = z
  .union([zAmount, z.literal("max")])
  .describe('Human amount, or "max" for the full balance/debt');

const getAavePositions: Capability<Record<string, never>> = {
  id: "getAavePositions",
  kind: "read",
  module: "aave",
  title: "Aave positions & health",
  summary: "Account health factor plus supplied/borrowed balances per reserve.",
  description:
    "Reads the wallet's Aave v3 account data (health factor, LTV, liquidation threshold, collateral " +
    "and debt in USD) together with its per-reserve positions. Read-only.",
  params: z.object({}),
  invoke: async (client) => ({
    account: await client.aave.getAccountData(),
    positions: await client.aave.getPositions(),
  }),
};

const getAaveMarket: Capability<{ assets?: string[] }> = {
  id: "getAaveMarket",
  kind: "read",
  module: "aave",
  title: "Aave market info",
  summary: "Supply/borrow APY, LTV, liquidation params and price per reserve.",
  description:
    "Reads Aave v3 reserve parameters: supply and variable-borrow APY, LTV, liquidation threshold and " +
    "bonus, active/frozen/borrowing flags, and oracle price. Pass `assets` to limit the list.",
  params: z.object({
    assets: z.array(zToken).optional().describe("Optional token symbols/addresses to limit to."),
  }),
  invoke: (client, p) => client.aave.getReserves(p.assets),
};

const aaveSupply: Capability<{ asset: string; amount: string }> = {
  id: "aaveSupply",
  kind: "write",
  module: "aave",
  title: "Supply to Aave",
  summary: "Deposit a token into Aave v3 as collateral.",
  description:
    "Atomic approve + supply on the Aave v3 Pool. Deposited on behalf of the wallet (pinned by policy). " +
    "The Pool must be in allowedProtocols and `asset` in allowedTokens; the approve counts toward the token budget.",
  params: z.object({ asset: zToken, amount: zAaveAmount }),
  invoke: (client, p) => client.aave.supply(p.asset, p.amount),
};

const aaveWithdraw: Capability<{ asset: string; amount: string }> = {
  id: "aaveWithdraw",
  kind: "write",
  module: "aave",
  title: "Withdraw from Aave",
  summary: "Withdraw supplied collateral from Aave v3 back to the wallet.",
  description:
    'Withdraws `asset` to the wallet (pinned by policy). Pass `"max"` to withdraw the entire supplied ' +
    "balance. The 0.15% agent fee applies to the amount received.",
  params: z.object({ asset: zToken, amount: zAaveAmountOrMax }),
  invoke: (client, p) => client.aave.withdraw(p.asset, p.amount),
};

const aaveBorrow: Capability<{ asset: string; amount: string }> = {
  id: "aaveBorrow",
  kind: "write",
  module: "aave",
  title: "Borrow from Aave",
  summary: "Borrow a token from Aave v3 against supplied collateral (variable rate).",
  description:
    "Borrows `asset` (variable rate) to the wallet, pinned by policy. Needs sufficient collateral or it " +
    "reverts; check getAavePositions first. The 0.15% agent fee applies to the amount received.",
  params: z.object({ asset: zToken, amount: zAaveAmount }),
  invoke: (client, p) => client.aave.borrow(p.asset, p.amount),
};

const aaveRepay: Capability<{ asset: string; amount: string }> = {
  id: "aaveRepay",
  kind: "write",
  module: "aave",
  title: "Repay Aave debt",
  summary: "Repay variable-rate debt with the underlying token.",
  description:
    'Atomic approve + repay. Pass `"max"` to repay the full debt (approves current debt + a small ' +
    "interest buffer). The Pool must be in allowedProtocols and in allowedRecipients if a whitelist is set.",
  params: z.object({ asset: zToken, amount: zAaveAmountOrMax }),
  invoke: (client, p) => client.aave.repay(p.asset, p.amount),
};

const aaveRepayWithATokens: Capability<{ asset: string; amount: string }> = {
  id: "aaveRepayWithATokens",
  kind: "write",
  module: "aave",
  title: "Repay Aave debt with aTokens",
  summary: "Repay debt directly from supplied collateral, no underlying needed.",
  description:
    "Not available on wallet V5: withdraw the asset and repay with it instead. " +
    'Repays variable-rate debt using the wallet\'s own aTokens — no approve, no underlying transfer. ' +
    'Pass `"max"` for the full debt. Useful for deleveraging in one step.',
  params: z.object({ asset: zToken, amount: zAaveAmountOrMax }),
  invoke: (client, p) => client.aave.repayWithATokens(p.asset, p.amount),
};

const aaveSetCollateral: Capability<{ asset: string; useAsCollateral: boolean }> = {
  id: "aaveSetCollateral",
  kind: "write",
  module: "aave",
  title: "Toggle Aave collateral",
  summary: "Enable or disable a supplied asset as collateral.",
  description:
    "Sets whether a supplied reserve counts as collateral. Disabling collateral lowers borrowing power and " +
    "can reduce the health factor — check getAavePositions first. Moves no funds.",
  params: z.object({
    asset: zToken,
    useAsCollateral: z.boolean().describe("true = use as collateral, false = disable"),
  }),
  invoke: (client, p) => client.aave.setCollateral(p.asset, p.useAsCollateral),
};

const aaveSetEMode: Capability<{ categoryId: number }> = {
  id: "aaveSetEMode",
  kind: "write",
  module: "aave",
  title: "Set Aave eMode",
  summary: "Switch the account's efficiency-mode category (0 = disabled).",
  description:
    "Sets the eMode category, which raises LTV/liquidation limits for correlated assets. Changing it " +
    "shifts the risk profile of the whole position — 0 disables eMode. Moves no funds.",
  params: z.object({
    categoryId: z.number().int().min(0).max(255).describe("eMode category id; 0 disables"),
  }),
  invoke: (client, p) => client.aave.setEMode(p.categoryId),
};

// Planners. The `plan*` pair is simulate-only; the `aaveDeleverage` /
// `aaveClosePosition` pair actually runs the loop and may send several
// transactions in one call — the descriptions must say so plainly.

const zPlannerControls = {
  slippageBps: z
    .number()
    .int()
    .positive()
    .describe("Required. Slippage in bps for each swap leg (100 = 1%)."),
  hfFloor: z
    .string()
    .optional()
    .describe("Minimum health factor after every chunk. Default '1.05'."),
  maximumIterations: z.number().int().positive().optional().describe("Hard cap on chunks. Default 10."),
  maxPriceImpactBps: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Abort if a swap prices more than this far below the Aave oracle. Default 200."),
  minimumChunkAmount: z.string().optional().describe("Abort if the safe chunk falls below this."),
  fee: z.number().int().optional().describe("Uniswap pool fee tier for the swap legs. Default 500."),
};

const aavePlanClosePosition: Capability<Record<string, unknown>> = {
  id: "aavePlanClosePosition",
  kind: "simulate",
  module: "aave",
  title: "Plan closing an Aave position",
  summary: "Project how the position would be closed, without sending anything.",
  description:
    "Returns the route it would take and, if chunking is needed, each chunk with the health factor it " +
    "would leave behind. Picks the cheapest viable route: repay from wallet balance if it covers the debt, " +
    "else repay from aTokens when debt and collateral are the same asset, else a chunked deleverage loop. " +
    "Sends nothing — use aaveClosePosition to execute.",
  params: z.object(zPlannerControls),
  invoke: (client, p) => client.aave.planClosePosition(p as never),
};

const aavePlanDeleverage: Capability<Record<string, unknown>> = {
  id: "aavePlanDeleverage",
  kind: "simulate",
  module: "aave",
  title: "Plan a deleverage",
  summary: "Project selling collateral to repay debt in safe chunks, without sending anything.",
  description:
    "Projects the chunked loop that repays `debtAsset` by selling `collateralAsset`. Each chunk keeps the " +
    "health factor above hfFloor. Aborts with a concrete reason (and, when the position is too tight to " +
    "chunk, the amount of debt to repay from the wallet to unblock it). Sends nothing.",
  params: z.object({
    collateralAsset: zToken,
    debtAsset: zToken,
    amount: z.union([zAmount, z.literal("all")]).optional().describe("Debt to clear. Default 'all'."),
    ...zPlannerControls,
  }),
  invoke: (client, p) => client.aave.planRepayWithCollateral(p as never),
};

const aaveClosePosition: Capability<Record<string, unknown>> = {
  id: "aaveClosePosition",
  kind: "write",
  module: "aave",
  title: "Close an Aave position",
  summary: "Repay all debt and withdraw all collateral. MAY SEND SEVERAL TRANSACTIONS.",
  description:
    "Runs the plan to completion. Each chunk is re-derived from live state, re-checked against every control " +
    "and simulated before being sent, so a single call can broadcast up to `maximumIterations` transactions. " +
    "Returns every tx hash plus what remains. Aborts without sending if any control is violated. " +
    "Call aavePlanClosePosition first to see what it intends to do.",
  params: z.object(zPlannerControls),
  invoke: (client, p) => client.aave.executePlan({ ...(p as Record<string, unknown>), kind: "closePosition" } as never),
};

const aaveDeleverage: Capability<Record<string, unknown>> = {
  id: "aaveDeleverage",
  kind: "write",
  module: "aave",
  title: "Deleverage an Aave position",
  summary: "Sell collateral to repay debt in safe chunks. MAY SEND SEVERAL TRANSACTIONS.",
  description:
    "Runs the chunked loop that repays `debtAsset` by selling `collateralAsset`, keeping the health factor " +
    "above hfFloor at every step. One call can broadcast several transactions. Returns every tx hash and the " +
    "debt still outstanding. Call aavePlanDeleverage first to preview.",
  params: z.object({
    collateralAsset: zToken,
    debtAsset: zToken,
    amount: z.union([zAmount, z.literal("all")]).optional().describe("Debt to clear. Default 'all'."),
    ...zPlannerControls,
  }),
  invoke: (client, p) => client.aave.executePlan({ ...(p as Record<string, unknown>), kind: "repayWithCollateral" } as never),
};

const aavePlanCollateralSwap: Capability<Record<string, unknown>> = {
  id: "aavePlanCollateralSwap",
  kind: "simulate",
  module: "aave",
  title: "Plan a collateral swap",
  summary: "Project migrating the collateral backing a position to another asset. Sends nothing.",
  description:
    "Projects the chunked migration of collateral from `fromAsset` to `toAsset`. Each chunk withdraws, swaps " +
    "and re-supplies, and is sized on the moment the old collateral has left but the new has not yet arrived — " +
    "Aave checks health per operation, so that dip is the binding constraint. Note the health factor can move " +
    "even at equal value, because assets have different liquidation thresholds. Sends nothing.",
  params: z.object({
    fromAsset: zToken,
    toAsset: zToken,
    amount: z.union([zAmount, z.literal("all")]).optional().describe("Collateral to migrate. Default 'all'."),
    ...zPlannerControls,
  }),
  invoke: (client, p) => client.aave.planCollateralSwap(p as never),
};

const aavePlanDebtSwap: Capability<Record<string, unknown>> = {
  id: "aavePlanDebtSwap",
  kind: "simulate",
  module: "aave",
  title: "Plan a debt swap",
  summary: "Project moving a debt to another asset. Sends nothing.",
  description:
    "Projects the chunked move of debt from `fromDebtAsset` to `toDebtAsset`. Each chunk borrows the new asset, " +
    "swaps it and repays the old one, and is sized on the instant BOTH debts are outstanding — briefly more " +
    "levered than the start. Expect the debt to grow slightly overall: every chunk pays two 0.15% fees plus swap " +
    "slippage. Sends nothing.",
  params: z.object({
    fromDebtAsset: zToken,
    toDebtAsset: zToken,
    amount: z.union([zAmount, z.literal("all")]).optional().describe("Debt to move. Default 'all'."),
    ...zPlannerControls,
  }),
  invoke: (client, p) => client.aave.planDebtSwap(p as never),
};

const aaveCollateralSwap: Capability<Record<string, unknown>> = {
  id: "aaveCollateralSwap",
  kind: "write",
  module: "aave",
  title: "Swap the collateral of an Aave position",
  summary: "Migrate collateral to another asset in safe chunks. MAY SEND SEVERAL TRANSACTIONS.",
  description:
    "Runs the migration to completion, re-deriving and re-checking each chunk from live state. Enables the " +
    "destination as collateral if it is not already. One call can broadcast several transactions. " +
    "Call aavePlanCollateralSwap first to preview.",
  params: z.object({
    fromAsset: zToken,
    toAsset: zToken,
    amount: z.union([zAmount, z.literal("all")]).optional().describe("Collateral to migrate. Default 'all'."),
    ...zPlannerControls,
  }),
  invoke: (client, p) =>
    client.aave.executePlan({ ...(p as Record<string, unknown>), kind: "collateralSwap" } as never),
};

const aaveDebtSwap: Capability<Record<string, unknown>> = {
  id: "aaveDebtSwap",
  kind: "write",
  module: "aave",
  title: "Swap the debt of an Aave position",
  summary: "Move a debt to another asset in safe chunks. MAY SEND SEVERAL TRANSACTIONS.",
  description:
    "Runs the debt move to completion, re-deriving and re-checking each chunk from live state. The total debt " +
    "ends slightly higher than it started — each chunk costs two 0.15% fees plus swap slippage. One call can " +
    "broadcast several transactions. Call aavePlanDebtSwap first to preview.",
  params: z.object({
    fromDebtAsset: zToken,
    toDebtAsset: zToken,
    amount: z.union([zAmount, z.literal("all")]).optional().describe("Debt to move. Default 'all'."),
    ...zPlannerControls,
  }),
  invoke: (client, p) => client.aave.executePlan({ ...(p as Record<string, unknown>), kind: "debtSwap" } as never),
};

const dryRunAaveSupply: Capability<{ asset: string; amount: string }> = {
  id: "dryRunAaveSupply",
  kind: "simulate",
  module: "aave",
  title: "Dry-run Aave supply",
  summary: "Simulate a supply (gas + revert reason) without sending.",
  description: "Same inputs as aaveSupply, but only simulates.",
  params: z.object({ asset: zToken, amount: zAaveAmount }),
  invoke: (client, p) => client.aave.dryRunSupply(p.asset, p.amount),
};

const dryRunAaveBorrow: Capability<{ asset: string; amount: string }> = {
  id: "dryRunAaveBorrow",
  kind: "simulate",
  module: "aave",
  title: "Dry-run Aave borrow",
  summary: "Simulate a borrow (gas + revert reason) without sending.",
  description: "Same inputs as aaveBorrow, but only simulates — surfaces 'not enough collateral' before you send.",
  params: z.object({ asset: zToken, amount: zAaveAmount }),
  invoke: (client, p) => client.aave.dryRunBorrow(p.asset, p.amount),
};

// ---------------------------------------------------------------------------
// Uniswap v3 liquidity (LP) — NonfungiblePositionManager
// ---------------------------------------------------------------------------
// mint/collect route to the wallet (pinned by the on-chain call policy). There is
// no increaseLiquidity tool: the NFPM does not gate it to the owner, so it would
// let an agent pull the wallet's approved tokens into an attacker-owned position —
// to add liquidity, open a fresh position.

const lpFeeParam = z
  .number()
  .int()
  .describe("Pool fee tier: 100 (0.01%), 500 (0.05%), 3000 (0.3%) or 10000 (1%).");

const addLiquidityV3: Capability<{
  tokenA: string;
  amountA: string;
  tokenB: string;
  amountB: string;
  fee: number;
  tickLower?: number;
  tickUpper?: number;
  priceLower?: string;
  priceUpper?: string;
  allowOutOfRange?: boolean;
  slippageBps?: number;
}> = {
  id: "addLiquidityV3",
  kind: "write",
  module: "lp",
  title: "Open a Uniswap v3 liquidity position",
  summary: "Provide two ERC-20 tokens as liquidity; the position NFT is owned by the wallet.",
  description:
    "Wallet V5: works where the Uniswap v3 position validator is active and the owner allowed it for this agent (getCapabilities \u2192 canProvideLiquidityV3); otherwise use addLiquidityV4. " +
    "Atomic approve(s) + mint on the Uniswap v3 NonfungiblePositionManager. The position NFT is minted " +
    "to the wallet (pinned by policy). `amountA`/`amountB` are the MAXIMUM you'll deposit of each token; " +
    "the SDK reads the pool's current price and sizes the two amounts to the pool ratio (so one side is " +
    "usually only partly used), with minimums slippageBps below the sized amounts (50 = 0.5%). Defaults to " +
    "FULL-RANGE; for a concentrated range pass priceLower/priceUpper (tokenA per tokenB) — preferred — or raw tickLower/tickUpper. A range that does not contain the current price is not opened on the first call: ask the user to confirm, then call again with allowOutOfRange: true and it is opened; the result reports the range read against the current price. Requires " +
    "the NFPM in allowedProtocols and both tokens in allowedTokens (the approves count toward the token " +
    "budget). ERC-20/ERC-20 only — native ETH LP is v4.",
  params: z.object({
    tokenA: zToken,
    amountA: zAmount,
    tokenB: zToken,
    amountB: zAmount,
    fee: lpFeeParam,
    tickLower: z.number().int().optional().describe("Lower tick for a concentrated range (advanced). Omit for full-range."),
    tickUpper: z.number().int().optional().describe("Upper tick for a concentrated range (advanced). Omit for full-range."),
    priceLower: zAmount
      .optional()
      .describe("Range as prices (preferred over ticks): the lower price, in tokenA per tokenB — e.g. 2000 for USDC per WETH. Give both bounds."),
    priceUpper: zAmount.optional().describe("Upper price of the range, in tokenA per tokenB."),
    allowOutOfRange: z
      .boolean()
      .optional()
      .describe("Set to true after the user confirms opening a position outside the current price (a single-token, limit-style position)."),
    slippageBps: z.number().int().optional().describe("Slippage for the amount minimums, in bps. Default 50 (0.5%)."),
  }),
  invoke: async (client, p) => {
    const a = await toBaseUnits(client, p.tokenA, p.amountA);
    const b = await toBaseUnits(client, p.tokenB, p.amountB);
    return client.addLiquidityV3({
      tokenA: a.address,
      amountA: a.raw,
      tokenB: b.address,
      amountB: b.raw,
      fee: p.fee,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      priceLower: p.priceLower,
      priceUpper: p.priceUpper,
      allowOutOfRange: p.allowOutOfRange,
      slippageBps: p.slippageBps,
    });
  },
};

const removeLiquidityV3: Capability<{ tokenId: string; bps?: number; burn?: boolean }> = {
  id: "removeLiquidityV3",
  kind: "write",
  module: "lp",
  title: "Remove Uniswap v3 liquidity",
  summary: "Withdraw part or all of a position's liquidity (plus fees) to the wallet.",
  description:
    "Wallet V5: needs the Uniswap v3 position validator active on this network (getCapabilities \u2192 canProvideLiquidityV3). " +
    "decreaseLiquidity + collect in one batch, both to the wallet. `bps` is the fraction of the " +
    "position's current liquidity to remove (10000 = all, the default). With `burn: true` a full " +
    "removal also burns the emptied NFT. Only works on positions the wallet owns (the NFPM enforces it).",
  params: z.object({
    tokenId: zTokenId,
    bps: z.number().int().min(1).max(10000).optional().describe("Fraction of liquidity to remove in bps (10000 = all). Default 10000."),
    burn: z.boolean().optional().describe("Burn the NFT after a full removal."),
  }),
  invoke: (client, p) => client.removeLiquidityV3({ tokenId: BigInt(p.tokenId), bps: p.bps, burn: p.burn }),
};

const collectFeesV3: Capability<{ tokenId: string }> = {
  id: "collectFeesV3",
  kind: "write",
  module: "lp",
  title: "Collect Uniswap v3 fees",
  summary: "Collect a position's owed fees to the wallet.",
  description:
    "Wallet V5: needs the Uniswap v3 position validator active on this network (getCapabilities \u2192 canProvideLiquidityV3). " +
    "Calls collect(recipient = wallet) on the NFPM, sweeping all owed fees to the wallet. Only the " +
    "position owner can collect (enforced by the NFPM). No BVCC fee is charged (v3 collect calldata " +
    "carries no token address for the fee snapshot to see).",
  params: z.object({ tokenId: zTokenId }),
  invoke: (client, p) => client.collectFeesV3(BigInt(p.tokenId)),
};

const burnV3: Capability<{ tokenId: string }> = {
  id: "burnV3",
  kind: "write",
  module: "lp",
  title: "Burn an empty Uniswap v3 position",
  summary: "Burn a position NFT once its liquidity and fees are zero.",
  description:
    "Wallet V5: needs the Uniswap v3 position validator active on this network (getCapabilities \u2192 canProvideLiquidityV3). " +
    "Burns the position NFT. The NFPM requires the position to be fully removed (liquidity and owed " +
    "fees both 0) first — use removeLiquidityV3 with burn:true to do both in one call.",
  params: z.object({ tokenId: zTokenId }),
  invoke: (client, p) => client.burnV3(BigInt(p.tokenId)),
};

const getV3Position: Capability<{ tokenId: string }> = {
  id: "getV3Position",
  kind: "read",
  module: "lp",
  title: "Read a Uniswap v3 position",
  summary: "Pool tokens, fee, tick range, liquidity and owed fees for a position id.",
  description:
    "Reads the NFPM `positions(tokenId)` record: token0/token1, fee tier, tick range, current liquidity " +
    "and owed fees. Read-only; use to size a removeLiquidityV3 or check what a position holds.",
  params: z.object({ tokenId: zTokenId }),
  invoke: async (client, p) => {
    const pos = await client.getV3Position(BigInt(p.tokenId));
    const [m0, m1] = await Promise.all([tokenMeta(client, pos.token0), tokenMeta(client, pos.token1)]);
    return {
      ...pos,
      liquidity: pos.liquidity.toString(),
      formatted: {
        pair: `${m0.symbol}/${m1.symbol}`,
        feeTier: `${pos.fee / 10000}%`,
        range: `[${pos.tickLower}, ${pos.tickUpper}]`,
        tokensOwed0: fmtAmount(pos.tokensOwed0, m0.decimals, m0.symbol),
        tokensOwed1: fmtAmount(pos.tokensOwed1, m1.decimals, m1.symbol),
      },
    };
  },
};

const dryRunAddLiquidityV3: Capability<{
  tokenA: string;
  amountA: string;
  tokenB: string;
  amountB: string;
  fee: number;
  tickLower?: number;
  tickUpper?: number;
  priceLower?: string;
  priceUpper?: string;
  allowOutOfRange?: boolean;
  slippageBps?: number;
}> = {
  id: "dryRunAddLiquidityV3",
  kind: "simulate",
  module: "lp",
  title: "Dry-run open v3 position",
  summary: "Simulate opening a v3 position (gas + revert reason) without sending.",
  description: "Wallet V5: needs the Uniswap v3 position validator active on this network. " + "Same inputs as addLiquidityV3, but only simulates.",
  params: addLiquidityV3.params,
  invoke: async (client, p) => {
    const a = await toBaseUnits(client, p.tokenA, p.amountA);
    const b = await toBaseUnits(client, p.tokenB, p.amountB);
    return enrichDryRun(
      client,
      await client.dryRunAddLiquidityV3({
        tokenA: a.address,
        amountA: a.raw,
        tokenB: b.address,
        amountB: b.raw,
        fee: p.fee,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
      priceLower: p.priceLower,
      priceUpper: p.priceUpper,
      allowOutOfRange: p.allowOutOfRange,
        slippageBps: p.slippageBps,
      }),
    );
  },
};

const dryRunRemoveLiquidityV3: Capability<{ tokenId: string; bps?: number; burn?: boolean }> = {
  id: "dryRunRemoveLiquidityV3",
  kind: "simulate",
  module: "lp",
  title: "Dry-run remove v3 liquidity",
  summary: "Simulate removing v3 liquidity (gas + revert reason) without sending.",
  description: "Wallet V5: needs the Uniswap v3 position validator active on this network. " + "Same inputs as removeLiquidityV3, but only simulates.",
  params: removeLiquidityV3.params,
  invoke: async (client, p) =>
    enrichDryRun(client, await client.dryRunRemoveLiquidityV3({ tokenId: BigInt(p.tokenId), bps: p.bps, burn: p.burn })),
};

// ---------------------------------------------------------------------------
// Uniswap v4 liquidity (LP) — PositionManager modifyLiquidities
// ---------------------------------------------------------------------------
// This is where NATIVE-ETH LP lives (currency0 = address(0)). Recipients are pinned
// to the wallet by the BVCCPositionManagerValidator (DEEP). It FAILS CLOSED until
// that validator is active in the registry (48h governance) and the owner has set
// the DEEP policy on (PositionManager, modifyLiquidities) — until then, use v3.
// Unlike v3, v4 DOES charge the BVCC fee on collect/decrease (the pool currencies
// are in the calldata for the fee snapshot).

const NATIVE_V4: Address = "0x0000000000000000000000000000000000000000";

/** Resolve a token or native ETH ("ETH"/"native"/zero address) to {address, raw}. */
async function toV4Currency(
  client: BvccAgentClient,
  token: string,
  human: string,
): Promise<{ address: Address; raw: bigint }> {
  const s = token.toLowerCase();
  if (s === "eth" || s === "native" || s === NATIVE_V4) {
    return { address: NATIVE_V4, raw: parseEther(human) };
  }
  return toBaseUnits(client, token, human);
}

const v4Warn = " Requires the v4 PositionManager in allowedProtocols with an ACTIVE DEEP validator; until then v4 LP fails closed — use the v3 tools.";

const addLiquidityV4: Capability<{
  tokenA: string;
  amountA: string;
  tokenB: string;
  amountB: string;
  fee: number;
  tickSpacing?: number;
  hooks?: string;
  tickLower?: number;
  tickUpper?: number;
  priceLower?: string;
  priceUpper?: string;
  allowOutOfRange?: boolean;
  slippageBps?: number;
}> = {
  id: "addLiquidityV4",
  kind: "write",
  module: "lp",
  title: "Open a Uniswap v4 liquidity position",
  summary: "Provide liquidity on Uniswap v4 — supports NATIVE ETH (use \"ETH\" as a token).",
  description:
    "Wallet V5: Permit2 is granted by the owner (the client leaves those steps out); one call may not both remove liquidity and add it elsewhere. " +
    "Mint a v4 position via the PositionManager. Use \"ETH\" for a native side (no wrapping — v4 pools " +
    "are native-first). `amountA`/`amountB` are the MAXIMUMS; the SDK reads the pool price and sizes the " +
    "amounts to the ratio. Defaults to full-range; for a concentrated range pass priceLower/priceUpper (tokenA per tokenB) — preferred — or raw tickLower/tickUpper. A range that does not contain the current price is not opened on the first call: ask the user to confirm, then call again with allowOutOfRange: true and it is opened. " +
    "`hooks` defaults to none — a hooked pool only works if that hook is approved in the BVCC hook registry. " +
    "The position and all proceeds are pinned to the wallet." + v4Warn,
  params: z.object({
    tokenA: zToken,
    amountA: zAmount,
    tokenB: zToken,
    amountB: zAmount,
    fee: lpFeeParam,
    tickSpacing: z.number().int().optional().describe("v4 tick spacing. Default derived from fee (500→10, 3000→60…)."),
    hooks: zAddress.optional().describe("Pool hook contract. Omit for a no-hook pool (must be approved otherwise)."),
    tickLower: z.number().int().optional(),
    tickUpper: z.number().int().optional(),
    priceLower: zAmount
      .optional()
      .describe("Range as prices (preferred over ticks): the lower price, in tokenA per tokenB — e.g. 2000 for USDC per WETH. Give both bounds."),
    priceUpper: zAmount.optional().describe("Upper price of the range, in tokenA per tokenB."),
    allowOutOfRange: z
      .boolean()
      .optional()
      .describe("Set to true after the user confirms opening a position outside the current price (a single-token, limit-style position)."),
    slippageBps: z.number().int().optional().describe("Slippage for the amount minimums, in bps. Default 50."),
  }),
  invoke: async (client, p) => {
    const a = await toV4Currency(client, p.tokenA, p.amountA);
    const b = await toV4Currency(client, p.tokenB, p.amountB);
    return client.addLiquidityV4({
      tokenA: a.address,
      amountA: a.raw,
      tokenB: b.address,
      amountB: b.raw,
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      hooks: p.hooks as Address | undefined,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      priceLower: p.priceLower,
      priceUpper: p.priceUpper,
      allowOutOfRange: p.allowOutOfRange,
      slippageBps: p.slippageBps,
    });
  },
};

const removeLiquidityV4: Capability<{ tokenId: string; bps?: number; burn?: boolean }> = {
  id: "removeLiquidityV4",
  kind: "write",
  module: "lp",
  title: "Remove Uniswap v4 liquidity",
  summary: "Withdraw part or all of a v4 position (plus fees) to the wallet.",
  description:
    "DECREASE + TAKE_PAIR to the wallet (or BURN on a full removal with burn:true). `bps` is the fraction " +
    "of liquidity to remove (10000 = all, default). Only the position owner can (enforced on-chain). The " +
    "BVCC fee applies to the proceeds." + v4Warn,
  params: z.object({
    tokenId: zTokenId,
    bps: z.number().int().min(1).max(10000).optional(),
    burn: z.boolean().optional().describe("Burn the position after a full removal."),
  }),
  invoke: (client, p) => client.removeLiquidityV4({ tokenId: BigInt(p.tokenId), bps: p.bps, burn: p.burn }),
};

const collectFeesV4: Capability<{ tokenId: string }> = {
  id: "collectFeesV4",
  kind: "write",
  module: "lp",
  title: "Collect Uniswap v4 fees",
  summary: "Collect a v4 position's owed fees to the wallet.",
  description: "DECREASE(0) + TAKE_PAIR to the wallet. The BVCC fee applies to the collected amount." + v4Warn,
  params: z.object({ tokenId: zTokenId }),
  invoke: (client, p) => client.collectFeesV4(BigInt(p.tokenId)),
};

const burnV4: Capability<{ tokenId: string }> = {
  id: "burnV4",
  kind: "write",
  module: "lp",
  title: "Burn a Uniswap v4 position",
  summary: "Remove all remaining liquidity and burn the position, to the wallet.",
  description: "BURN_POSITION + TAKE_PAIR to the wallet (v4 burn auto-removes remaining liquidity)." + v4Warn,
  params: z.object({ tokenId: zTokenId }),
  invoke: (client, p) => client.burnV4(BigInt(p.tokenId)),
};

const getV4Position: Capability<{ tokenId: string }> = {
  id: "getV4Position",
  kind: "read",
  module: "lp",
  title: "Read a Uniswap v4 position",
  summary: "Pool key (currencies, fee, tickSpacing, hooks) and current liquidity for a v4 position id.",
  description: "Reads the v4 PositionManager's pool key and liquidity for a tokenId. Read-only.",
  params: z.object({ tokenId: zTokenId }),
  invoke: async (client, p) => {
    const pos = await client.getV4Position(BigInt(p.tokenId));
    return { ...pos, liquidity: pos.liquidity.toString() };
  },
};

const dryRunAddLiquidityV4: Capability<{
  tokenA: string;
  amountA: string;
  tokenB: string;
  amountB: string;
  fee: number;
  tickSpacing?: number;
  hooks?: string;
  tickLower?: number;
  tickUpper?: number;
  priceLower?: string;
  priceUpper?: string;
  allowOutOfRange?: boolean;
  slippageBps?: number;
}> = {
  id: "dryRunAddLiquidityV4",
  kind: "simulate",
  module: "lp",
  title: "Dry-run open v4 position",
  summary: "Simulate opening a v4 position (gas + revert reason) without sending.",
  description: "Same inputs as addLiquidityV4, but only simulates. Surfaces the fail-closed revert if the v4 validator is not active yet.",
  params: addLiquidityV4.params,
  invoke: async (client, p) => {
    const a = await toV4Currency(client, p.tokenA, p.amountA);
    const b = await toV4Currency(client, p.tokenB, p.amountB);
    return enrichDryRun(
      client,
      await client.dryRunAddLiquidityV4({
        tokenA: a.address,
        amountA: a.raw,
        tokenB: b.address,
        amountB: b.raw,
        fee: p.fee,
        tickSpacing: p.tickSpacing,
        hooks: p.hooks as Address | undefined,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
      priceLower: p.priceLower,
      priceUpper: p.priceUpper,
      allowOutOfRange: p.allowOutOfRange,
        slippageBps: p.slippageBps,
      }),
    );
  },
};

const dryRunRemoveLiquidityV4: Capability<{ tokenId: string; bps?: number; burn?: boolean }> = {
  id: "dryRunRemoveLiquidityV4",
  kind: "simulate",
  module: "lp",
  title: "Dry-run remove v4 liquidity",
  summary: "Simulate removing v4 liquidity (gas + revert reason) without sending.",
  description: "Same inputs as removeLiquidityV4, but only simulates.",
  params: removeLiquidityV4.params,
  invoke: async (client, p) =>
    enrichDryRun(client, await client.dryRunRemoveLiquidityV4({ tokenId: BigInt(p.tokenId), bps: p.bps, burn: p.burn })),
};

// --- Guides (help; module "meta" → always exposed) -------------------------

const listGuidesParams = z.object({});
const listGuides: Capability<z.infer<typeof listGuidesParams>> = {
  id: "listGuides",
  kind: "read",
  title: "List operating guides",
  summary: "List the how-to guides (getting-started, swaps, lending, liquidity).",
  description:
    "Returns the available operating guides, one line each. Call getGuide with an `area` to read the " +
    "full playbook (recommended workflow + gotchas) before your first action in an unfamiliar area. " +
    "Pull only the area you need.",
  module: "meta",
  params: listGuidesParams,
  invoke: async () => guideList(),
};

const getGuideParams = z.object({
  area: z.enum(["getting-started", "swaps", "lending", "liquidity"]).describe("Which guide to read."),
});
const getGuide: Capability<z.infer<typeof getGuideParams>> = {
  id: "getGuide",
  kind: "read",
  title: "Read an operating guide",
  summary: "Read the how-to playbook for one area (getting-started | swaps | lending | liquidity).",
  description:
    "Returns the recommended workflow and the gotchas for one area, naming the exact tools to call. " +
    "Read the relevant guide before your first action in an area you haven't used. " +
    "area: getting-started | swaps | lending | liquidity.",
  module: "meta",
  params: getGuideParams,
  invoke: async (_client, { area }) => guideText(area),
};

export const CATALOG: readonly Capability<never>[] = [
  // guides (help; always exposed regardless of module filter)
  listGuides,
  getGuide,
  // reads
  getAgentStatus,
  getCapabilities,
  getNativeBalance,
  getTokenBalances,
  getRemaining,
  needsApproval,
  // simulations
  buildSwapPlan,
  dryRunSendNative,
  dryRunSendToken,
  dryRunSwapV3,
  dryRunSwapV4,
  // Aave reads + simulations
  getAavePositions,
  getAaveMarket,
  dryRunAaveSupply,
  dryRunAaveBorrow,
  aavePlanClosePosition,
  aavePlanDeleverage,
  aavePlanCollateralSwap,
  aavePlanDebtSwap,
  // LP (Uniswap v3) reads + simulations
  getV3Position,
  dryRunAddLiquidityV3,
  dryRunRemoveLiquidityV3,
  // LP (Uniswap v4) reads + simulations
  getV4Position,
  dryRunAddLiquidityV4,
  dryRunRemoveLiquidityV4,
  // writes
  sendNative,
  sendToken,
  approve,
  swapV3,
  swapV4,
  swapToNative,
  swapFromNative,
  // Aave writes
  aaveSupply,
  aaveWithdraw,
  aaveBorrow,
  aaveRepay,
  aaveRepayWithATokens,
  aaveSetCollateral,
  aaveSetEMode,
  aaveClosePosition,
  aaveDeleverage,
  aaveCollateralSwap,
  aaveDebtSwap,
  // LP (Uniswap v3) writes
  addLiquidityV3,
  removeLiquidityV3,
  collectFeesV3,
  burnV3,
  // LP (Uniswap v4) writes
  addLiquidityV4,
  removeLiquidityV4,
  collectFeesV4,
  burnV4,
] as unknown as readonly Capability<never>[];

/** Look up a capability by id. */
export function getCapability(id: string): Capability<never> | undefined {
  return CATALOG.find((c) => c.id === id);
}

/** Capabilities of a given kind — e.g. `capabilitiesByKind("read")` for a read-only wrapper. */
export function capabilitiesByKind(kind: CapabilityKind): readonly Capability<never>[] {
  return CATALOG.filter((c) => c.kind === kind);
}
