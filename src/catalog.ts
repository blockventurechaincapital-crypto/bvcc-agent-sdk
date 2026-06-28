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
import { formatUnits, isAddress, parseEther, parseUnits, type Address } from "viem";
import { z } from "zod";
import { erc20Abi } from "./abi.js";
import type { BvccAgentClient } from "./client.js";
import { resolveToken } from "./tokens.js";
import { PERMIT2 } from "./universalRouter.js";

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
  /** Invoke against a live client. Returns whatever the underlying method returns. */
  invoke: (client: BvccAgentClient, args: A) => Promise<unknown>;
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
//   - cap/limit/budget fields: 0 (or null) means UNLIMITED.
//   - remaining fields: null means UNLIMITED, 0 means EXHAUSTED ("0").
//   - spent fields: always a literal amount.
// ---------------------------------------------------------------------------

/** A cap/limit/budget: 0 or null renders as "unlimited". */
function fmtCap(raw: bigint | null, decimals: number, symbol: string): string {
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
    .describe("Deliver native ETH by unwrapping WETH output. `tokenOut` must be WETH."),
});
type SwapV4Args = z.infer<typeof swapV4Params>;

const swapV4: Capability<SwapV4Args> = {
  id: "swapV4",
  kind: "write",
  title: "Swap on Uniswap v4 (Universal Router + Permit2)",
  summary: "Exact-input swap via Uniswap v4 pools through the Universal Router.",
  description:
    "Permit2-funded v4 swap through the Universal Router — byte-compatible with app.uniswap.org. " +
    "Reaches liquidity living on v4 pools (identified by fee + tickSpacing). Requires BOTH the " +
    "Universal Router and Permit2 in allowedProtocols, and `tokenIn` in allowedTokens. " +
    "Pass `amountOutMinimum` (exact) or `slippageBps` (e.g. 50 = 0.5%, 100 = 1%); one is required.",
  params: swapV4Params,
  invoke: async (client, p) => {
    const inUnits = await toBaseUnits(client, p.tokenIn, p.amountIn);
    const { outAddress, minRaw } = await deriveMinOut(client, "v4", {
      ...p,
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
      // Onboarding: if the agent isn't authorized yet, point the user to set it up.
      ...(s.isAuthorized
        ? {}
        : {
            suggestedAction:
              "This agent is not authorized on this wallet/chain. Create a BVCC Agent Wallet " +
              "and authorize this agent's address at https://bvccwallet.blockventurechaincapital.com, " +
              "then retry.",
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
    "means that limit is unlimited/disabled on-chain.",
  params: z.object({}),
  invoke: async (client) => {
    const r = await client.getRemaining();
    const cur = client.network.currency;
    const tokens = await Promise.all(
      r.tokens.map(async (t) => {
        const { decimals, symbol } = await tokenMeta(client, t.token);
        return {
          ...t,
          symbol,
          decimals,
          formatted: {
            maxPerTx: fmtCap(t.maxPerTx, decimals, symbol),
            dailyLimit: fmtCap(t.dailyLimit, decimals, symbol),
            totalBudget: fmtCap(t.totalBudget, decimals, symbol),
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
        maxPerTx: fmtCap(r.maxPerTxWei, 18, cur),
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
export const CATALOG: readonly Capability<never>[] = [
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
  // writes
  sendNative,
  sendToken,
  approve,
  swapV3,
  swapV4,
] as unknown as readonly Capability<never>[];

/** Look up a capability by id. */
export function getCapability(id: string): Capability<never> | undefined {
  return CATALOG.find((c) => c.id === id);
}

/** Capabilities of a given kind — e.g. `capabilitiesByKind("read")` for a read-only wrapper. */
export function capabilitiesByKind(kind: CapabilityKind): readonly Capability<never>[] {
  return CATALOG.filter((c) => c.kind === kind);
}
