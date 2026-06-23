import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  slice,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { agentWalletAbi, erc20Abi, permit2AllowanceAbi, swapRouter02Abi } from "./abi.js";
import { getNetwork, type BvccNetwork } from "./networks.js";
import {
  buildUniversalRouterSwap,
  PERMIT2,
  type UniversalRouterSwapParams,
} from "./universalRouter.js";
import { buildV4SwapExactIn, type V4SwapExactInParams } from "./universalRouterV4.js";
import { decodeRevert, type DecodedRevert } from "./errors.js";
import { resolveToken } from "./tokens.js";
import {
  applySlippage,
  quoteV3ExactInputSingle,
  quoteV4ExactInputSingle,
} from "./quote.js";
import {
  fail,
  ok,
  type ActionContext,
  type ActionName,
  type ActionResult,
} from "./results.js";
import type {
  AgentPermission,
  AgentStatus,
  Balance,
  Capabilities,
  DryRunResult,
  Execution,
  PreflightResult,
  RemainingBudget,
  SwapPlan,
  TokenBudget,
} from "./types.js";

/**
 * ERC-7821 batch execution mode. `executeAsAgent` expects this for the
 * `abi.encode(Execution[])` calldata layout.
 */
export const BATCH_MODE: Hex =
  "0x0100000000000000000000000000000000000000000000000000000000000000";

export interface BvccAgentClientOptions {
  /**
   * The agent's signer. Either a raw private key (`0x...`) or a viem `Account`.
   * This EOA pays gas and must be the address you authorized on-chain.
   */
  account: Hex | Account;
  /** Address of the BVCC Agent Wallet this agent operates. */
  walletAddress: Address;
  /** Chain id of a known BVCC network, or a full network object for custom RPCs. */
  network: number | BvccNetwork;
  /** Override the network's default RPC (recommended for production). */
  rpcUrl?: string;
  /** Provide a custom viem transport instead of `http(rpcUrl)`. */
  transport?: Transport;
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";

const subOrNull = (limit: bigint, spent: bigint): bigint | null =>
  limit === 0n ? null : limit > spent ? limit - spent : 0n;

/**
 * Client for operating a BVCC Agent Wallet from an off-chain AI agent.
 *
 * The agent is a plain EOA: it signs a normal transaction calling
 * `executeAsAgent`, pays its own gas, and the wallet enforces every spending
 * limit on-chain. There is no Account Abstraction / bundler / WebAuthn on this
 * path — the user's Face ID signer is only needed to *authorize* the agent.
 */
export class BvccAgentClient {
  readonly network: BvccNetwork;
  readonly account: Account;
  readonly walletAddress: Address;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;

  constructor(opts: BvccAgentClientOptions) {
    this.network =
      typeof opts.network === "number" ? getNetwork(opts.network) : opts.network;
    this.account =
      typeof opts.account === "string"
        ? privateKeyToAccount(opts.account)
        : opts.account;
    this.walletAddress = opts.walletAddress;

    const transport = opts.transport ?? http(opts.rpcUrl ?? this.network.rpcUrl);
    const chain = {
      id: this.network.chainId,
      name: this.network.name,
      nativeCurrency: { name: this.network.currency, symbol: this.network.currency, decimals: 18 },
      rpcUrls: { default: { http: [opts.rpcUrl ?? this.network.rpcUrl] } },
    } as const;

    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: this.account, chain, transport });
  }

  /** The agent EOA address (derived from the signer). */
  get agentAddress(): Address {
    return this.account.address;
  }

  // ------------------------------------------------------------------
  // Execution builders (pure — return Execution items, do not broadcast)
  // ------------------------------------------------------------------

  /** Build a native ETH/BNB transfer. */
  buildSendNative(to: Address, amountWei: bigint): Execution {
    return { target: to, value: amountWei, callData: "0x" };
  }

  /** Build an ERC-20 transfer. */
  buildSendToken(token: Address, to: Address, amount: bigint): Execution {
    return {
      target: token,
      value: 0n,
      callData: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [to, amount],
      }),
    };
  }

  /** Build an ERC-20 approve. Counts toward token budgets on-chain (anti cap-bypass). */
  buildApprove(token: Address, spender: Address, amount: bigint): Execution {
    return {
      target: token,
      value: 0n,
      callData: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, amount],
      }),
    };
  }

  /**
   * Build an approve + Uniswap v3 `exactInputSingle` swap as a 2-item batch.
   * The router must be whitelisted in `allowedProtocols`, and `tokenIn` in
   * `allowedTokens`. Output is sent back to the wallet. ERC-20 in/out only
   * (wrap/unwrap native yourself if needed).
   */
  buildSwapExactInputV3(params: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    amountOutMinimum: bigint;
    fee?: number;
    router?: Address;
  }): Execution[] {
    const router = params.router ?? this.network.swapRouter02;
    if (!router) {
      throw new Error(
        `No swapRouter02 configured for ${this.network.name}. Pass { router }.`,
      );
    }
    const swapData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          fee: params.fee ?? 3000,
          recipient: this.walletAddress,
          amountIn: params.amountIn,
          amountOutMinimum: params.amountOutMinimum,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return [
      this.buildApprove(params.tokenIn, router, params.amountIn),
      { target: router, value: 0n, callData: swapData },
    ];
  }

  /**
   * Build a Uniswap **Universal Router** exact-input swap batch (Permit2 funding)
   * — aligned with the router the BVCC frontend uses. Supports token→token,
   * native→token and token→native (via WRAP_ETH / UNWRAP_WETH). The router
   * defaults to the network's `universalRouter`; pass `router` where it's not
   * preconfigured.
   *
   * The agent's `allowedProtocols` must include **both Permit2 and the router**.
   * For token input, `tokenIn` must be in `allowedTokens` (the leading
   * `approve(Permit2, amountIn)` is counted toward the token budget). A wrong
   * router address reverts rather than losing funds. This path has not been
   * exercised against the wallet's fee-snapshot logic on mainnet — test on
   * Arbitrum Sepolia first.
   */
  buildSwapViaUniversalRouter(
    params: Omit<UniversalRouterSwapParams, "router" | "recipient"> & { router?: Address },
  ): Execution[] {
    const router = params.router ?? this.network.universalRouter;
    if (!router) {
      throw new Error(
        `No universalRouter configured for ${this.network.name}. Pass { router } explicitly ` +
          `(a wrong router address can lose funds via the transfer-to-router pattern).`,
      );
    }
    return buildUniversalRouterSwap({ ...params, router, recipient: this.walletAddress });
  }

  /** Submit a Universal Router (v3) exact-input swap. Structured result. */
  swapViaUniversalRouter(
    params: Parameters<BvccAgentClient["buildSwapViaUniversalRouter"]>[0],
  ): Promise<ActionResult> {
    return this.run("swapUniversalRouter", this.buildSwapViaUniversalRouter(params));
  }

  /**
   * Build a Uniswap **v4** exact-input swap batch through the Universal Router
   * (command V4_SWAP), Permit2-funded — byte-compatible with app.uniswap.org's
   * v4 swaps. Use this to reach liquidity that lives on v4 pools. Single-hop via
   * `{ fee, tickSpacing, hooks? }` or multi-hop via `{ path }`; `nativeOut` adds
   * an UNWRAP_WETH leg (then `tokenOut` must be WETH).
   *
   * `allowedProtocols` must include **Permit2 and the router**; `tokenIn` must be
   * in `allowedTokens`. Defaults the router to the network's `universalRouter`.
   */
  buildSwapV4ExactIn(
    params: Omit<V4SwapExactInParams, "router" | "recipient"> & { router?: Address },
  ): Execution[] {
    const router = params.router ?? this.network.universalRouter;
    if (!router) {
      throw new Error(
        `No universalRouter configured for ${this.network.name}. Pass { router } explicitly.`,
      );
    }
    return buildV4SwapExactIn({ ...params, router, recipient: this.walletAddress });
  }

  /** Submit a Uniswap v4 exact-input swap. Structured result. */
  swapV4ExactIn(params: Parameters<BvccAgentClient["buildSwapV4ExactIn"]>[0]): Promise<ActionResult> {
    return this.run("swapV4", this.buildSwapV4ExactIn(params));
  }

  /** ABI-encode a batch into `executionData` for `executeAsAgent`. */
  encodeExecutions(executions: Execution[]): Hex {
    return encodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
            { name: "callData", type: "bytes" },
          ],
        },
      ],
      [executions],
    );
  }

  // ------------------------------------------------------------------
  // Execution (broadcast)
  // ------------------------------------------------------------------

  /** Submit a batch of executions via `executeAsAgent`. Returns the tx hash. */
  async execute(executions: Execution[]): Promise<Hex> {
    const data = encodeFunctionData({
      abi: agentWalletAbi,
      functionName: "executeAsAgent",
      args: [BATCH_MODE, this.encodeExecutions(executions)],
    });
    return this.walletClient.sendTransaction({
      account: this.account,
      chain: this.walletClient.chain,
      to: this.walletAddress,
      data,
    });
  }

  /** Submit a batch and wait for the receipt. */
  async executeAndWait(executions: Execution[]) {
    const hash = await this.execute(executions);
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** Send native currency. Returns a structured {@link ActionResult}. */
  sendNative(to: Address, amountWei: bigint): Promise<ActionResult> {
    return this.run("sendNative", [this.buildSendNative(to, amountWei)]);
  }

  /** Send an ERC-20 token. Returns a structured {@link ActionResult}. */
  sendToken(token: Address, to: Address, amount: bigint): Promise<ActionResult> {
    return this.run("sendToken", [this.buildSendToken(token, to, amount)]);
  }

  /** Approve a spender. Returns a structured {@link ActionResult}. */
  approve(token: Address, spender: Address, amount: bigint): Promise<ActionResult> {
    return this.run("approve", [this.buildApprove(token, spender, amount)]);
  }

  /** Uniswap v3 exact-input swap (approve + swap, atomic). Structured result. */
  swapExactInputV3(
    params: Parameters<BvccAgentClient["buildSwapExactInputV3"]>[0],
  ): Promise<ActionResult> {
    return this.run("swapV3", this.buildSwapExactInputV3(params));
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  /** Read this agent's full on-chain permission struct. */
  async getPermission(agent: Address = this.agentAddress): Promise<AgentPermission> {
    const p = (await this.publicClient.readContract({
      address: this.walletAddress,
      abi: agentWalletAbi,
      functionName: "getAgentPermission",
      args: [agent],
    })) as AgentPermission;
    return p;
  }

  /** ETH spent by this agent today (UTC day). */
  getDailySpentNative(agent: Address = this.agentAddress): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.walletAddress,
      abi: agentWalletAbi,
      functionName: "getDailySpent",
      args: [agent],
    }) as Promise<bigint>;
  }

  /** A token's spend for this agent: `[dailySpent, totalSpent]`. */
  async getTokenSpent(
    token: Address,
    agent: Address = this.agentAddress,
  ): Promise<{ dailySpent: bigint; totalSpent: bigint }> {
    const [dailySpent, totalSpent] = (await this.publicClient.readContract({
      address: this.walletAddress,
      abi: agentWalletAbi,
      functionName: "getTokenSpent",
      args: [agent, token],
    })) as [bigint, bigint];
    return { dailySpent, totalSpent };
  }

  /** Whether all agents are globally paused on the wallet. */
  isPaused(): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.walletAddress,
      abi: agentWalletAbi,
      functionName: "paused",
    }) as Promise<boolean>;
  }

  /**
   * Compute remaining headroom across every limit, fetching live spend.
   * `null` means that limit is unlimited / disabled on-chain.
   */
  async getRemaining(agent: Address = this.agentAddress): Promise<RemainingBudget> {
    const perm = await this.getPermission(agent);
    const dailySpentNative = await this.getDailySpentNative(agent);

    const now = BigInt(Math.floor(Date.now() / 1000));
    const expired = perm.expiry !== 0n && now >= perm.expiry;

    // Period rollover is lazy on-chain; reflect it here for an accurate view.
    const periodEnabled = perm.periodBudgetWei > 0n && perm.periodDuration > 0n;
    let periodSpent = perm.periodSpentWei;
    let periodResetsInSeconds: bigint | null = null;
    if (periodEnabled) {
      const periodEnd = perm.periodStart + perm.periodDuration;
      if (now >= periodEnd) {
        periodSpent = 0n;
        periodResetsInSeconds = perm.periodDuration;
      } else {
        periodResetsInSeconds = periodEnd - now;
      }
    }

    const tokens: TokenBudget[] = [];
    for (let i = 0; i < perm.allowedTokens.length; i++) {
      const token = perm.allowedTokens[i];
      const { dailySpent, totalSpent } = await this.getTokenSpent(token, agent);
      const dailyLimit = perm.tokenDailyLimits[i] ?? 0n;
      const totalBudget = perm.tokenTotalBudgets[i] ?? 0n;
      tokens.push({
        token,
        maxPerTx: perm.tokenMaxAmounts[i] ?? 0n,
        dailyLimit,
        totalBudget,
        dailySpent,
        totalSpent,
        dailyRemaining: subOrNull(dailyLimit, dailySpent),
        totalRemaining: subOrNull(totalBudget, totalSpent),
      });
    }

    return {
      active: perm.active,
      expired,
      maxPerTxWei: perm.maxPerTxWei === 0n ? null : perm.maxPerTxWei,
      dailyRemainingWei: subOrNull(perm.dailyLimitWei, dailySpentNative),
      totalRemainingWei: subOrNull(perm.totalBudgetWei, perm.totalSpentWei),
      periodRemainingWei: periodEnabled
        ? subOrNull(perm.periodBudgetWei, periodSpent)
        : null,
      periodResetsInSeconds,
      tokens,
    };
  }

  /**
   * Preflight an ETH spend against active state, per-tx, daily, period and
   * total limits. Does not check recipient whitelist or gas — it catches the
   * common reverts before you pay for a failed transaction.
   */
  async canSpendNative(amountWei: bigint, agent: Address = this.agentAddress): Promise<PreflightResult> {
    const r = await this.getRemaining(agent);
    if (!r.active) return { ok: false, reason: "Agent is not active (revoked or never authorized)." };
    if (r.expired) return { ok: false, reason: "Agent permissions have expired." };
    if (await this.isPaused()) return { ok: false, reason: "All agents are paused on this wallet." };
    if (r.maxPerTxWei !== null && amountWei > r.maxPerTxWei)
      return { ok: false, reason: `Exceeds per-tx limit (${r.maxPerTxWei} wei).` };
    if (r.dailyRemainingWei !== null && amountWei > r.dailyRemainingWei)
      return { ok: false, reason: `Exceeds remaining daily limit (${r.dailyRemainingWei} wei left).` };
    if (r.periodRemainingWei !== null && amountWei > r.periodRemainingWei)
      return { ok: false, reason: `Exceeds remaining period budget (${r.periodRemainingWei} wei left).` };
    if (r.totalRemainingWei !== null && amountWei > r.totalRemainingWei)
      return { ok: false, reason: `Exceeds remaining lifetime budget (${r.totalRemainingWei} wei left).` };
    return { ok: true };
  }

  /** Preflight an ERC-20 spend against the token's per-tx / daily / total limits. */
  async canSpendToken(
    token: Address,
    amount: bigint,
    agent: Address = this.agentAddress,
  ): Promise<PreflightResult> {
    const r = await this.getRemaining(agent);
    if (!r.active) return { ok: false, reason: "Agent is not active." };
    if (r.expired) return { ok: false, reason: "Agent permissions have expired." };
    const tb = r.tokens.find((t) => t.token.toLowerCase() === token.toLowerCase());
    if (!tb) return { ok: false, reason: `Token ${token} is not in the agent's allowedTokens whitelist.` };
    if (tb.maxPerTx !== 0n && amount > tb.maxPerTx)
      return { ok: false, reason: `Exceeds per-tx token limit (${tb.maxPerTx}).` };
    if (tb.dailyRemaining !== null && amount > tb.dailyRemaining)
      return { ok: false, reason: `Exceeds remaining daily token limit (${tb.dailyRemaining} left).` };
    if (tb.totalRemaining !== null && amount > tb.totalRemaining)
      return { ok: false, reason: `Exceeds remaining lifetime token budget (${tb.totalRemaining} left).` };
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Structured results
  // ------------------------------------------------------------------

  private ctx(): ActionContext {
    return {
      network: this.network.name,
      chainId: this.network.chainId,
      walletAddress: this.walletAddress,
      agentAddress: this.agentAddress,
    };
  }

  /**
   * Send a batch and return a structured {@link ActionResult} (success with
   * txHash, or failure with a decoded, human-readable reason). Used by the
   * convenience methods. The low-level {@link execute}/{@link executeAndWait}
   * primitives are unchanged.
   */
  async run(action: ActionName, executions: Execution[]): Promise<ActionResult> {
    try {
      const txHash = await this.execute(executions);
      return ok(action, txHash, this.ctx());
    } catch (e) {
      return fail(action, decodeRevert(e), this.ctx());
    }
  }

  /** Decode any thrown/revert value into a human-readable explanation. */
  explainFailure(error: unknown): DecodedRevert {
    return decodeRevert(error);
  }

  // ------------------------------------------------------------------
  // Dry-run (simulate + gas estimate; never broadcasts)
  // ------------------------------------------------------------------

  /** Simulate a batch and estimate gas without sending. */
  async dryRun(action: ActionName, executions: Execution[]): Promise<DryRunResult> {
    const preview = executions.map((e) => ({
      target: e.target,
      value: e.value,
      selector: (e.callData && e.callData !== "0x" ? slice(e.callData, 0, 4) : "0x") as Hex,
    }));
    const data = encodeFunctionData({
      abi: agentWalletAbi,
      functionName: "executeAsAgent",
      args: [BATCH_MODE, this.encodeExecutions(executions)],
    });
    try {
      const estimatedGas = await this.publicClient.estimateGas({
        account: this.account.address,
        to: this.walletAddress,
        data,
      });
      let estimatedNetworkFeeWei: bigint | null = null;
      try {
        const gasPrice = await this.publicClient.getGasPrice();
        estimatedNetworkFeeWei = estimatedGas * gasPrice;
      } catch {
        /* fee optional — leave null if the node can't report a gas price */
      }
      return { ok: true, action, estimatedGas, estimatedNetworkFeeWei, preview, failure: null };
    } catch (e) {
      return {
        ok: false,
        action,
        estimatedGas: null,
        estimatedNetworkFeeWei: null,
        preview,
        failure: decodeRevert(e),
      };
    }
  }

  /** Alias of {@link dryRun} — simulate and, on failure, explain why. */
  simulateAndExplain(executions: Execution[], action: ActionName = "execute"): Promise<DryRunResult> {
    return this.dryRun(action, executions);
  }

  dryRunSendNative(to: Address, amountWei: bigint): Promise<DryRunResult> {
    return this.dryRun("sendNative", [this.buildSendNative(to, amountWei)]);
  }
  dryRunSendToken(token: Address, to: Address, amount: bigint): Promise<DryRunResult> {
    return this.dryRun("sendToken", [this.buildSendToken(token, to, amount)]);
  }
  dryRunApprove(token: Address, spender: Address, amount: bigint): Promise<DryRunResult> {
    return this.dryRun("approve", [this.buildApprove(token, spender, amount)]);
  }
  dryRunSwapV3(params: Parameters<BvccAgentClient["buildSwapExactInputV3"]>[0]): Promise<DryRunResult> {
    return this.dryRun("swapV3", this.buildSwapExactInputV3(params));
  }
  dryRunSwapV4(params: Parameters<BvccAgentClient["buildSwapV4ExactIn"]>[0]): Promise<DryRunResult> {
    return this.dryRun("swapV4", this.buildSwapV4ExactIn(params));
  }

  // ------------------------------------------------------------------
  // Status & capabilities
  // ------------------------------------------------------------------

  /** High-level snapshot of the agent's on-chain authorization. */
  async getAgentStatus(agent: Address = this.agentAddress): Promise<AgentStatus> {
    const [p, isPaused] = await Promise.all([this.getPermission(agent), this.isPaused()]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    return {
      walletAddress: this.walletAddress,
      agentAddress: agent,
      network: this.network.name,
      chainId: this.network.chainId,
      isAuthorized: p.active,
      isExpired: p.expiry !== 0n && now >= p.expiry,
      isPaused,
      expiry: p.expiry,
      allowedTokens: p.allowedTokens,
      allowedProtocols: p.allowedProtocols,
      allowedRecipients: p.allowedRecipients,
    };
  }

  /** Derive what the agent can currently do from its on-chain permission. */
  async getCapabilities(agent: Address = this.agentAddress): Promise<Capabilities> {
    const [p, isPaused] = await Promise.all([this.getPermission(agent), this.isPaused()]);
    const protos = p.allowedProtocols.map((a) => a.toLowerCase());
    const has = (a?: Address) => !!a && protos.includes(a.toLowerCase());
    const hasPermit2 = protos.includes(PERMIT2.toLowerCase());
    const now = BigInt(Math.floor(Date.now() / 1000));
    const expired = p.expiry !== 0n && now >= p.expiry;
    const live = p.active && !expired && !isPaused;
    const hasTokens = p.allowedTokens.length > 0;

    const notes: string[] = [];
    if (!p.active) notes.push("Agent is not active (revoked or never authorized).");
    if (expired) notes.push("Agent permissions have expired.");
    if (isPaused) notes.push("All agents are paused on this wallet.");
    if (!hasTokens) notes.push("No tokens whitelisted — token transfers and swaps are denied.");
    if (p.allowedProtocols.length === 0) notes.push("No protocols whitelisted — swaps/DeFi are denied.");
    if (p.allowedRecipients.length > 0)
      notes.push("Recipient whitelist active — only listed recipients are allowed.");
    if (has(this.network.universalRouter) && !hasPermit2)
      notes.push("Universal Router whitelisted but Permit2 is not — v4/UR swaps will revert.");

    return {
      canSendNative: live,
      canSendTokens: live && hasTokens,
      canApprove: live && hasTokens,
      canSwapV3: live && hasTokens && has(this.network.swapRouter02),
      canSwapV4: live && hasTokens && has(this.network.universalRouter) && hasPermit2,
      allowedSwapTokens: p.allowedTokens,
      allowedProtocols: p.allowedProtocols,
      notes,
    };
  }

  // ------------------------------------------------------------------
  // Balances
  // ------------------------------------------------------------------

  /** The wallet's native balance, formatted. */
  async getNativeBalance(): Promise<Balance> {
    const raw = await this.publicClient.getBalance({ address: this.walletAddress });
    return {
      token: "native",
      symbol: this.network.currency,
      decimals: 18,
      raw,
      formatted: formatEther(raw),
    };
  }

  /** The wallet's balance of a token (symbol or address). */
  async getTokenBalance(token: Address | string): Promise<Balance> {
    const resolved = resolveToken(this.network.chainId, token);
    const address = resolved.address;
    const raw = (await this.publicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [this.walletAddress],
    })) as bigint;

    let decimals = resolved.decimals;
    if (decimals == null) {
      try {
        decimals = Number(
          await this.publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
        );
      } catch {
        decimals = 18;
      }
    }
    let symbol = resolved.symbol;
    if (symbol == null) {
      try {
        symbol = (await this.publicClient.readContract({
          address,
          abi: erc20Abi,
          functionName: "symbol",
        })) as string;
      } catch {
        symbol = `${address.slice(0, 6)}…${address.slice(-4)}`;
      }
    }
    return { token: address, symbol, decimals, raw, formatted: formatUnits(raw, decimals) };
  }

  /** Balances for several tokens (symbols or addresses). */
  getBalances(tokens: (Address | string)[]): Promise<Balance[]> {
    return Promise.all(tokens.map((t) => this.getTokenBalance(t)));
  }

  // ------------------------------------------------------------------
  // Allowances / Permit2
  // ------------------------------------------------------------------

  /** Standard ERC-20 allowance of `owner` (default: the wallet) to `spender`. */
  getErc20Allowance(
    token: Address,
    spender: Address,
    owner: Address = this.walletAddress,
  ): Promise<bigint> {
    return this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    }) as Promise<bigint>;
  }

  /** Permit2 allowance of `owner` (default: the wallet) for `token` to `spender`. */
  async getPermit2Allowance(
    token: Address,
    spender: Address,
    owner: Address = this.walletAddress,
  ): Promise<{ amount: bigint; expiration: number; nonce: number }> {
    const [amount, expiration, nonce] = (await this.publicClient.readContract({
      address: PERMIT2,
      abi: permit2AllowanceAbi,
      functionName: "allowance",
      args: [owner, token, spender],
    })) as [bigint, number, number];
    return { amount, expiration, nonce };
  }

  /**
   * Whether an approval is needed before `spender` can move `amount` of `token`
   * from the wallet. For the Universal Router path pass `{ viaPermit2: true }`
   * (checks both the ERC-20 → Permit2 allowance and the Permit2 → router
   * allowance/expiration). Prefer exact-amount approvals over unlimited.
   */
  async needsApproval(
    token: Address,
    spender: Address,
    amount: bigint,
    opts?: { viaPermit2?: boolean },
  ): Promise<boolean> {
    if (opts?.viaPermit2) {
      const [ercToPermit2, p2] = await Promise.all([
        this.getErc20Allowance(token, PERMIT2),
        this.getPermit2Allowance(token, spender),
      ]);
      const now = Math.floor(Date.now() / 1000);
      const p2Ok = p2.amount >= amount && (p2.expiration === 0 || p2.expiration > now);
      return !(ercToPermit2 >= amount && p2Ok);
    }
    const allowance = await this.getErc20Allowance(token, spender);
    return allowance < amount;
  }

  // ------------------------------------------------------------------
  // Swap planning
  // ------------------------------------------------------------------

  /**
   * Build a {@link SwapPlan} (does not submit). Resolves required protocols/
   * tokens, whether an approval is needed, and warnings (e.g. protocol/token not
   * whitelisted, or no min). With `{ quote: true }` it fills `amountOutMinimum`
   * from the on-chain Quoter and slippage — if quoting fails, the plan is still
   * returned with a warning (never throws on quote/read failures).
   */
  async buildSwapPlan(params: {
    protocol: "v3" | "v4";
    tokenIn: Address | string;
    tokenOut: Address | string;
    amountIn: bigint;
    fee?: number;
    tickSpacing?: number;
    /** Quote on-chain to set amountOutMinimum. Default false. */
    quote?: boolean;
    /** Slippage in basis points for the quote (default 50 = 0.5%). */
    slippageBps?: number;
  }): Promise<SwapPlan> {
    const tokenIn = resolveToken(this.network.chainId, params.tokenIn).address;
    const tokenOut = resolveToken(this.network.chainId, params.tokenOut).address;
    const fee = params.fee ?? 3000;
    const tickSpacing = params.protocol === "v4" ? (params.tickSpacing ?? 60) : null;
    const warnings: string[] = [];

    const requiredProtocols: Address[] =
      params.protocol === "v3"
        ? this.network.swapRouter02
          ? [this.network.swapRouter02]
          : []
        : this.network.universalRouter
          ? [this.network.universalRouter, PERMIT2]
          : [PERMIT2];

    if (params.protocol === "v3" && !this.network.swapRouter02)
      warnings.push(`No SwapRouter02 configured for ${this.network.name}.`);
    if (params.protocol === "v4" && !this.network.universalRouter)
      warnings.push(`No Universal Router configured for ${this.network.name} — pass one explicitly.`);

    // Cross-check against what the agent is actually allowed to do.
    try {
      const caps = await this.getCapabilities();
      const can = params.protocol === "v3" ? caps.canSwapV3 : caps.canSwapV4;
      if (!can) warnings.push(`Agent cannot currently swap on ${params.protocol} (see getCapabilities().notes).`);
      const allowed = caps.allowedSwapTokens.map((a) => a.toLowerCase());
      if (allowed.length > 0 && !allowed.includes(tokenIn.toLowerCase()))
        warnings.push("tokenIn is not in the agent's allowedTokens whitelist.");
    } catch {
      warnings.push("Could not read agent capabilities (RPC issue) — proceeding without that check.");
    }

    // needsApproval (best-effort; never throws).
    let needsApproval = true;
    try {
      const spender = params.protocol === "v3" ? this.network.swapRouter02 : this.network.universalRouter;
      if (spender) {
        needsApproval = await this.needsApproval(tokenIn, spender, params.amountIn, {
          viaPermit2: params.protocol === "v4",
        });
      }
    } catch {
      warnings.push("Could not read current allowance — assuming approval is needed.");
    }

    // Optional on-chain quote.
    let amountOutMinimum: bigint | null = null;
    if (params.quote) {
      const slippageBps = params.slippageBps ?? 50;
      try {
        let amountOut: bigint | null = null;
        if (params.protocol === "v3") {
          if (!this.network.quoterV2) throw new Error("no quoterV2");
          amountOut = await quoteV3ExactInputSingle(this.publicClient, this.network.quoterV2, {
            tokenIn,
            tokenOut,
            amountIn: params.amountIn,
            fee,
          });
        } else {
          // v4: try the v4 quoter first. If its pool params (fee/tickSpacing) don't
          // match a live pool, or it reverts, fall back to the v3 quote of the same
          // pair as a price proxy — so a slippage bound always exists rather than
          // leaving amountOutMinimum null (which invites a min-0, unprotected swap).
          if (this.network.v4Quoter) {
            try {
              amountOut = await quoteV4ExactInputSingle(this.publicClient, this.network.v4Quoter, {
                tokenIn,
                tokenOut,
                amountIn: params.amountIn,
                fee,
                tickSpacing: tickSpacing ?? 60,
              });
            } catch {
              amountOut = null;
            }
          }
          if (amountOut == null && this.network.quoterV2) {
            amountOut = await quoteV3ExactInputSingle(this.publicClient, this.network.quoterV2, {
              tokenIn,
              tokenOut,
              amountIn: params.amountIn,
              fee,
            });
            warnings.push(
              "v4 quote unavailable — amountOutMinimum derived from the v3 pool of the same pair as a price proxy. Verify it before swapping on v4.",
            );
          }
          if (amountOut == null) throw new Error("no v4 or v3 quote available");
        }
        amountOutMinimum = applySlippage(amountOut, slippageBps);
      } catch {
        warnings.push(
          "Quote unavailable (no verified quoter for this network or the quote reverted) — amountOutMinimum is null; set it yourself before swapping.",
        );
      }
    } else {
      warnings.push("Not quoted: amountOutMinimum is null. Quote and set a real minimum before swapping.");
    }

    return {
      protocol: params.protocol,
      tokenIn,
      tokenOut,
      amountIn: params.amountIn,
      amountOutMinimum,
      fee,
      tickSpacing,
      hops: [tokenIn, tokenOut],
      requiredProtocols,
      requiredTokens: [tokenIn],
      needsApproval,
      estimatedGas: null,
      warnings,
    };
  }
}

export { ZERO as ZERO_ADDRESS };
