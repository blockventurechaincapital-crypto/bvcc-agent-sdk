import {
  concat,
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

import {
  agentWalletAbi,
  agentWalletV5Abi,
  erc20Abi,
  nfpmAbi,
  permit2AllowanceAbi,
  swapRouter02Abi,
  v3FactoryAbi,
  v3PoolAbi,
  v4StateViewAbi,
  v4PositionManagerReadAbi,
} from "./abi.js";
import { detectWalletVersion, getActiveValidator, getPolicy, SELECTORS, type WalletVersion } from "./policy.js";
import { adaptBatchForV5, remainingUnder, v5Unlimited, withAgentFee } from "./v5.js";
import { refreshStaleDeadlines } from "./deadlines.js";
import { describeRange, pricesToTicks, tickFromSqrtPrice, type RangeInfo } from "./lp/range.js";
import { DEFAULT_SOURCE, encodeSourceTag, type SourceTagOptions } from "./sourceTag.js";
import { AaveClient } from "./aave/client.js";
import { getAaveAddresses } from "./aave/addresses.js";
import { buildNativeToToken, buildTokenToNative } from "./nativeSwap.js";
import { getNetwork, type BvccNetwork } from "./networks.js";
import {
  buildUniversalRouterSwap,
  PERMIT2,
  type UniversalRouterSwapParams,
} from "./universalRouter.js";
import { buildV4SwapExactIn, type V4SwapExactInParams } from "./universalRouterV4.js";
import {
  buildMintV3,
  buildDecreaseV3,
  buildCollectV3,
  buildBurnV3,
  orderV3Tokens,
} from "./lp/v3.js";
import {
  feeToTickSpacing,
  fullRangeTicks,
  nearestUsableTick,
  minusSlippage,
  getSqrtRatioAtTick,
  amountsForLiquidity,
  getLiquidityForAmounts,
  alignTickUp,
  alignTickDown,
  MIN_TICK,
  MAX_TICK,
} from "./lp/tickMath.js";
import {
  buildMintV4,
  buildDecreaseV4,
  buildCollectV4,
  buildBurnV4,
  orderV4Currencies,
  poolId as v4PoolId,
  NATIVE as V4_NATIVE,
  type V4PoolKey,
} from "./lp/v4.js";
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
  MissingPolicy,
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
  /**
   * Eight bytes appended to each `executeAsAgent` call naming the tool and version
   * that built it (see `sourceTag.ts`). Defaults to this SDK and its version. The
   * wallet ignores them; pass `false` to leave them out.
   */
  sourceTag?: SourceTagOptions | false;
  /**
   * Extra gas on top of the estimate, in basis points (2000 = +20%, the default).
   * Sending with exactly the estimate fails when the state moves a little before the
   * transaction is mined (accrued LP fees, Arbitrum's L1 cost). Unused gas is not paid.
   */
  gasBufferBps?: number;
}

const DEFAULT_GAS_BUFFER_BPS = 2_000;

/** Range options shared by the v3 and v4 liquidity planners. */
export interface LiquidityRangeParams {
  /**
   * The range as prices: how many `tokenA` one `tokenB` is worth (e.g. tokenA USDC,
   * tokenB WETH → 2000 and 3000). Converted to ticks with both tokens' decimals —
   * prefer this over raw ticks.
   */
  priceLower?: number | string;
  priceUpper?: number | string;
  /** Open the position even if the range does not contain the current price. */
  allowOutOfRange?: boolean;
}

/** A planned range that does not contain the current price. */
export class OutOfRangeError extends Error {
  readonly bvccDecoded: DecodedRevert;
  constructor(readonly range: RangeInfo) {
    super(range.warnings[0] ?? "The range does not contain the current price.");
    this.name = "OutOfRangeError";
    this.bvccDecoded = {
      errorName: "RangeOutOfPrice",
      humanMessage: `Needs confirmation: ${this.message}`,
      suggestedAction:
        `Ask the user whether to open this position outside the current price (${range.priceCurrent}). ` +
        `If they confirm, call again with the same parameters plus allowOutOfRange: true — it will be opened. ` +
        `If not, use a range that contains the current price.`,
      rawError: `range ${range.priceLower}-${range.priceUpper}, current ${range.priceCurrent}`,
      retryable: false,
    };
  }
}

/** A planner error as a decoded failure (planning throws plain errors too). */
function planningFailure(e: unknown): DecodedRevert {
  if (e && typeof e === "object" && "bvccDecoded" in e) return (e as { bvccDecoded: DecodedRevert }).bvccDecoded;
  const msg = e instanceof Error ? e.message : String(e);
  return {
    errorName: "PlanningFailed",
    humanMessage: msg,
    suggestedAction: "Fix the inputs named in the message, then try again.",
    rawError: msg.slice(0, 160),
    retryable: false,
  };
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";


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
  private readonly sourceTagHex: Hex | null;
  private readonly gasBufferBps: number;

  constructor(opts: BvccAgentClientOptions) {
    this.network =
      typeof opts.network === "number" ? getNetwork(opts.network) : opts.network;
    this.account =
      typeof opts.account === "string"
        ? privateKeyToAccount(opts.account)
        : opts.account;
    this.walletAddress = opts.walletAddress;
    this.sourceTagHex = opts.sourceTag === false ? null : encodeSourceTag(opts.sourceTag ?? DEFAULT_SOURCE);
    this.gasBufferBps = opts.gasBufferBps ?? DEFAULT_GAS_BUFFER_BPS;

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

  /** The wallet's generation (`"v2"` … `"v5"`), read once from the chain and cached. */
  walletVersion(): Promise<WalletVersion> {
    return detectWalletVersion(this.publicClient, this.walletAddress);
  }

  /**
   * The batch as this wallet will accept it. On V5 the agent's own Permit2 grants
   * are dropped (the owner grants them), SwapRouter02 swaps go through the
   * Universal Router, and what V5 does not allow is refused with a clear reason.
   * Earlier generations get the batch unchanged.
   */
  async prepareBatch(executions: Execution[]): Promise<Execution[]> {
    const chainNow = await this.chainTime();
    let batch = executions;
    if ((await this.walletVersion()) === "v5") {
      const [v3LiquidityActive, wrapActive] = await Promise.all([
        this.v5ValidatorActive(this.network.nfpm),
        this.v5ValidatorActive(this.network.weth),
      ]);
      batch = adaptBatchForV5(batch, {
        wallet: this.walletAddress,
        v3LiquidityActive,
        wrapActive,
        universalRouter: this.network.universalRouter,
        swapRouter02: this.network.swapRouter02,
        nfpm: this.network.nfpm,
        weth: this.network.weth,
        now: chainNow ?? undefined,
      });
    }
    // Deadlines come from the computer's clock; renew any the chain already sees as past.
    if (chainNow !== null) {
      batch = refreshStaleDeadlines(batch, chainNow, {
        universalRouter: this.network.universalRouter,
        positionManagerV4: this.network.positionManagerV4,
        nfpm: this.network.nfpm,
      });
    }
    return batch;
  }

  /** The wallet's (V5) validator registry, read once. */
  private v5Registry?: Promise<Address>;
  private v5RegistryAddress(): Promise<Address> {
    return (this.v5Registry ??= this.publicClient.readContract({
      address: this.walletAddress,
      abi: agentWalletV5Abi,
      functionName: "VALIDATOR_REGISTRY",
    }) as Promise<Address>);
  }

  /** Whether the wallet's V5 registry has an active validator for `target`. */
  private async v5ValidatorActive(target?: Address): Promise<boolean> {
    if (!target) return false;
    try {
      return (await getActiveValidator(this.publicClient, await this.v5RegistryAddress(), target)) !== null;
    } catch {
      return false;
    }
  }

  /** The latest block's timestamp, or null if the node cannot be reached. */
  private async chainTime(): Promise<bigint | null> {
    try {
      return (await this.publicClient.getBlock({ blockTag: "latest" })).timestamp;
    } catch {
      return null;
    }
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
   * `{ fee, tickSpacing, hooks? }` or multi-hop via `{ path }`; `nativeOut` routes
   * through the native (address(0)) pool and TAKEs ETH straight to the wallet.
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
  async swapV4ExactIn(
    params: Parameters<BvccAgentClient["buildSwapV4ExactIn"]>[0],
  ): Promise<ActionResult> {
    return this.run("swapV4", this.buildSwapV4ExactIn(params));
  }

  // ------------------------------------------------------------------
  // Native ETH swaps (own batches via SwapRouter02 + WETH)
  // ------------------------------------------------------------------

  /** Resolve the router and WETH this chain needs for a native swap. */
  private nativeSwapDeps(router?: Address): { router: Address; weth: Address } {
    const r = router ?? this.network.swapRouter02;
    if (!r) throw new Error(`No swapRouter02 configured for ${this.network.name}. Pass { router }.`);
    if (!this.network.weth) throw new Error(`No WETH address known for ${this.network.name}.`);
    return { router: r, weth: this.network.weth };
  }

  /**
   * token → native ETH, as one atomic batch. Exact-output, so no WETH dust is left
   * behind, and one 0.15% fee is charged.
   *
   * WETH must be in `allowedProtocols` (the unwrap targets it) and `tokenIn` in
   * `allowedTokens`.
   */
  buildSwapToNative(params: {
    tokenIn: Address;
    amountOut: bigint;
    amountInMaximum: bigint;
    fee?: number;
    router?: Address;
    /** Wallet V5 fee model (set for you by `swapToNative`). */
    feeOnTop?: boolean;
  }): Execution[] {
    const { router, weth } = this.nativeSwapDeps(params.router);
    return buildTokenToNative({ ...params, router, weth, wallet: this.walletAddress });
  }

  /** Submit a token → ETH swap. Structured result. */
  async swapToNative(params: Parameters<BvccAgentClient["buildSwapToNative"]>[0]): Promise<ActionResult> {
    const feeOnTop = params.feeOnTop ?? (await this.walletVersion()) === "v5";
    return this.run("swapToNative", this.buildSwapToNative({ ...params, feeOnTop }));
  }

  /**
   * native ETH → token, as one atomic batch.
   *
   * The 0.15% agent fee applies. The swap is sized to the post-fee WETH, not to
   * the ETH sent.
   */
  buildSwapFromNative(params: {
    tokenOut: Address;
    amountIn: bigint;
    amountOutMinimum: bigint;
    fee?: number;
    router?: Address;
    /** Wallet V5 fee model (set for you by `swapFromNative`). */
    feeOnTop?: boolean;
  }): Execution[] {
    const { router, weth } = this.nativeSwapDeps(params.router);
    return buildNativeToToken({ ...params, router, weth, wallet: this.walletAddress });
  }

  /** Submit an ETH → token swap (0.15% agent fee). Structured result. */
  async swapFromNative(params: Parameters<BvccAgentClient["buildSwapFromNative"]>[0]): Promise<ActionResult> {
    const feeOnTop = params.feeOnTop ?? (await this.walletVersion()) === "v5";
    return this.run("swapFromNative", this.buildSwapFromNative({ ...params, feeOnTop }));
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
    const batch = await this.prepareBatch(executions);
    const data = this.agentCalldata(batch);
    // Estimate first: a batch that would revert throws here and is never sent. Then
    // send with a margin, because the exact estimate runs out of gas when the state
    // moves a little before the transaction is mined.
    const estimated = await this.publicClient.estimateGas({
      account: this.account.address,
      to: this.walletAddress,
      data,
    });
    const gas = (estimated * BigInt(10_000 + this.gasBufferBps)) / 10_000n;
    return this.walletClient.sendTransaction({
      account: this.account,
      chain: this.walletClient.chain,
      to: this.walletAddress,
      data,
      gas,
    });
  }

  /** `executeAsAgent` calldata for a prepared batch, with the source tag when enabled. */
  private agentCalldata(batch: Execution[]): Hex {
    const call = encodeFunctionData({
      abi: agentWalletAbi,
      functionName: "executeAsAgent",
      args: [BATCH_MODE, this.encodeExecutions(batch)],
    });
    return this.sourceTagHex ? concat([call, this.sourceTagHex]) : call;
  }

  /** Submit a batch and wait for the receipt. */
  async executeAndWait(executions: Execution[]) {
    const hash = await this.execute(executions);
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  /** Send native currency. Returns a structured {@link ActionResult}. */
  async sendNative(to: Address, amountWei: bigint): Promise<ActionResult> {
    const short = await this.feeRoomShortfall("native", amountWei);
    if (short) return fail("sendNative", short, this.ctx());
    return this.run("sendNative", [this.buildSendNative(to, amountWei)]);
  }

  /**
   * The most the agent can move of a token (or `"native"`) out of the wallet's
   * current balance. On wallet V5 the 0.15% agent fee is paid on top of the amount
   * from the same balance, so moving the whole balance fails; this leaves room for it.
   * Earlier generations: the balance itself.
   */
  async maxSpendable(token: Address | "native"): Promise<bigint> {
    const balance =
      token === "native"
        ? await this.publicClient.getBalance({ address: this.walletAddress })
        : ((await this.publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [this.walletAddress],
          })) as bigint);
    if ((await this.walletVersion()) !== "v5") return balance;
    // Largest x with x + floor(x * 1500 / 1e6) <= balance.
    let x = (balance * 1_000_000n) / 1_001_500n;
    while (withAgentFee(x + 1n) <= balance) x += 1n;
    while (x > 0n && withAgentFee(x) > balance) x -= 1n;
    return x;
  }

  /**
   * On V5, a move the balance covers but the fee on top does not: explain it before
   * any gas is spent, naming the most that can be moved. Null when it fits (or pre-V5).
   */
  private async feeRoomShortfall(token: Address | "native", amount: bigint): Promise<DecodedRevert | null> {
    if ((await this.walletVersion()) !== "v5") return null;
    const max = await this.maxSpendable(token);
    if (amount <= max) return null;
    const bal = token === "native" ? await this.getNativeBalance() : await this.getTokenBalance(token);
    if (amount > bal.raw) return null; // simply not enough: the chain's own error says so
    const human = `${formatUnits(max, bal.decimals)} ${bal.symbol}`;
    return {
      errorName: "NoRoomForFee",
      humanMessage: `The wallet holds this amount, but not the 0.15% agent fee paid on top of it. The most that can be moved now is ${human}.`,
      suggestedAction: `Send at most ${human}, not the whole balance.`,
      rawError: `amount ${amount} > maxSpendable ${max}`,
      retryable: false,
    };
  }


  /** Send an ERC-20 token. Returns a structured {@link ActionResult}. */
  async sendToken(token: Address, to: Address, amount: bigint): Promise<ActionResult> {
    const short = await this.feeRoomShortfall(token, amount);
    if (short) return fail("sendToken", short, this.ctx());
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
  // Uniswap v3 liquidity (NonfungiblePositionManager)
  // ------------------------------------------------------------------
  // mint/collect route to the wallet — the on-chain call policy pins the recipient
  // (mint word 9, collect word 1), so a wrong recipient reverts. No increaseLiquidity
  // helper: the NFPM does not gate it to the owner, so it would be a recipient bypass;
  // to add liquidity, mint a fresh position.

  /** Resolve the NFPM for this chain (or the override), else throw. */
  private lpNfpm(nfpm?: Address): Address {
    const a = nfpm ?? this.network.nfpm;
    if (!a) {
      throw new Error(
        `No Uniswap v3 NonfungiblePositionManager configured for ${this.network.name}. Pass { nfpm }.`,
      );
    }
    return a;
  }

  /** Read a v3 position's pool, range, liquidity and owed fees. */
  async getV3Position(
    tokenId: bigint,
    nfpm?: Address,
  ): Promise<{
    token0: Address;
    token1: Address;
    fee: number;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    tokensOwed0: bigint;
    tokensOwed1: bigint;
  }> {
    const p = (await this.publicClient.readContract({
      address: this.lpNfpm(nfpm),
      abi: nfpmAbi,
      functionName: "positions",
      args: [tokenId],
    })) as readonly [
      bigint,
      Address,
      Address,
      Address,
      number,
      number,
      number,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    return {
      token0: p[2],
      token1: p[3],
      fee: Number(p[4]),
      tickLower: Number(p[5]),
      tickUpper: Number(p[6]),
      liquidity: p[7],
      tokensOwed0: p[10],
      tokensOwed1: p[11],
    };
  }

  /**
   * Build an "open v3 position" batch: approve(s) + mint, recipient = wallet.
   * Range defaults to full-range for the fee tier; pass explicit `tickLower`/
   * `tickUpper` for a concentrated position (they are aligned to the pool's tick
   * spacing). Amount minimums default to `slippageBps` below the desired amounts
   * (50 bps = 0.5%). Tokens are address-sorted internally, so pass amounts against
   * the tokens you name (tokenA↔amountA, tokenB↔amountB).
   *
   * The NFPM must be in `allowedProtocols` with the NFPM call policies registered;
   * both approves count toward the agent's token budget.
   */
  buildAddLiquidityV3(params: {
    tokenA: Address;
    amountA: bigint;
    tokenB: Address;
    amountB: bigint;
    fee: number;
    tickLower?: number;
    tickUpper?: number;
    amountAMin?: bigint;
    amountBMin?: bigint;
    slippageBps?: number;
    deadline?: bigint;
    nfpm?: Address;
  }): Execution[] {
    const nfpm = this.lpNfpm(params.nfpm);
    const { token0, token1, amount0, amount1, flipped } = orderV3Tokens(
      params.tokenA,
      params.amountA,
      params.tokenB,
      params.amountB,
    );
    const slip = params.slippageBps ?? 50;
    const minA = params.amountAMin ?? minusSlippage(params.amountA, slip);
    const minB = params.amountBMin ?? minusSlippage(params.amountB, slip);
    const amount0Min = flipped ? minB : minA;
    const amount1Min = flipped ? minA : minB;

    let tickLower: number;
    let tickUpper: number;
    if (params.tickLower != null && params.tickUpper != null) {
      const spacing = feeToTickSpacing(params.fee);
      tickLower = nearestUsableTick(params.tickLower, spacing);
      tickUpper = nearestUsableTick(params.tickUpper, spacing);
      if (tickLower >= tickUpper) throw new Error("tickLower must be < tickUpper after alignment.");
    } else {
      ({ tickLower, tickUpper } = fullRangeTicks(params.fee));
    }

    return buildMintV3({
      nfpm,
      token0,
      token1,
      fee: params.fee,
      tickLower,
      tickUpper,
      amount0Desired: amount0,
      amount1Desired: amount1,
      amount0Min,
      amount1Min,
      recipient: this.walletAddress,
      deadline: params.deadline,
    });
  }

  /** Read a v3 pool's current sqrtPriceX96 (via the factory), for sizing a mint. */
  async getV3PoolSqrtPrice(
    token0: Address,
    token1: Address,
    fee: number,
    factory?: Address,
  ): Promise<bigint> {
    const f = factory ?? this.network.v3Factory;
    if (!f) {
      throw new Error(
        `No Uniswap v3 factory configured for ${this.network.name}. Pass amounts already matched to the pool ratio.`,
      );
    }
    const pool = (await this.publicClient.readContract({
      address: f,
      abi: v3FactoryAbi,
      functionName: "getPool",
      args: [token0, token1, fee],
    })) as Address;
    if (pool === ZERO) {
      throw new Error(`No Uniswap v3 pool exists for that pair at fee ${fee} on ${this.network.name}.`);
    }
    const slot0 = (await this.publicClient.readContract({
      address: pool,
      abi: v3PoolAbi,
      functionName: "slot0",
    })) as readonly [bigint, number, number, number, number, number, boolean];
    return slot0[0];
  }

  /**
   * Size an "open v3 position" batch from the pool's current price so the two
   * amounts are matched to the pool ratio and the amount minimums hold. `amountA`/
   * `amountB` are treated as the MAXIMUM you're willing to deposit of each token;
   * the balanced (usually smaller) actual amounts are computed from the price and
   * chosen range. Falls back to the naive `buildAddLiquidityV3` only if no factory
   * is configured for the chain. Async (reads the pool); use for real mints.
   */
  async planAddLiquidityV3(params: LiquidityRangeParams & {
    tokenA: Address;
    amountA: bigint;
    tokenB: Address;
    amountB: bigint;
    fee: number;
    tickLower?: number;
    tickUpper?: number;
    slippageBps?: number;
    deadline?: bigint;
    nfpm?: Address;
    factory?: Address;
  }): Promise<Execution[]> {
    return (await this.planAddLiquidityV3Detailed(params)).executions;
  }

  /**
   * {@link planAddLiquidityV3} plus the range it resolved, read against the pool's
   * current price (with warnings). A range that does not contain the current price is
   * refused unless `allowOutOfRange` is set.
   */
  async planAddLiquidityV3Detailed(
    params: Parameters<BvccAgentClient["planAddLiquidityV3"]>[0],
  ): Promise<{ executions: Execution[]; range: RangeInfo | null }> {
    const factory = params.factory ?? this.network.v3Factory;
    // No factory → cannot read the price; fall back to the caller's raw amounts.
    if (!factory) return { executions: this.buildAddLiquidityV3(params), range: null };

    const nfpm = this.lpNfpm(params.nfpm);
    const { token0, token1, amount0: amount0Max, amount1: amount1Max } = orderV3Tokens(
      params.tokenA,
      params.amountA,
      params.tokenB,
      params.amountB,
    );

    const aIsToken0 = token0.toLowerCase() === params.tokenA.toLowerCase();
    const [metaA, metaB] = await Promise.all([this.lpTokenMeta(params.tokenA), this.lpTokenMeta(params.tokenB)]);
    const spacing = feeToTickSpacing(params.fee);
    let tickLower: number;
    let tickUpper: number;
    let fullRange = false;
    const fromPrices = this.ticksFromPrices(params, metaA.decimals, metaB.decimals, aIsToken0);
    if (fromPrices) {
      tickLower = alignTickDown(fromPrices.tickLower, spacing);
      tickUpper = alignTickUp(fromPrices.tickUpper, spacing);
    } else if (params.tickLower != null && params.tickUpper != null) {
      tickLower = nearestUsableTick(params.tickLower, spacing);
      tickUpper = nearestUsableTick(params.tickUpper, spacing);
    } else {
      ({ tickLower, tickUpper } = fullRangeTicks(params.fee));
      fullRange = true;
    }
    if (tickLower >= tickUpper) throw new Error("tickLower must be < tickUpper after alignment.");

    const sqrtP = await this.getV3PoolSqrtPrice(token0, token1, params.fee, factory);
    const range = this.checkRange(sqrtP, tickLower, tickUpper, metaA, metaB, aIsToken0, fullRange, params.allowOutOfRange);
    const sqrtA = getSqrtRatioAtTick(tickLower);
    const sqrtB = getSqrtRatioAtTick(tickUpper);
    const liquidity = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0Max, amount1Max);
    if (liquidity <= 0n) {
      throw new Error("Could not size any liquidity from the given amounts — increase one side.");
    }
    // The amounts the NFPM will actually pull for this liquidity (≤ the maxes).
    const { amount0, amount1 } = amountsForLiquidity(sqrtP, tickLower, tickUpper, liquidity);
    const slip = params.slippageBps ?? 50;

    const executions = buildMintV3({
      nfpm,
      token0,
      token1,
      fee: params.fee,
      tickLower,
      tickUpper,
      amount0Desired: amount0,
      amount1Desired: amount1,
      amount0Min: minusSlippage(amount0, slip),
      amount1Min: minusSlippage(amount1, slip),
      recipient: this.walletAddress,
      deadline: params.deadline,
    });
    return { executions, range };
  }

  /** Open a v3 position (amounts auto-balanced to the pool ratio). Structured result. */
  async addLiquidityV3(
    params: Parameters<BvccAgentClient["planAddLiquidityV3"]>[0],
  ): Promise<ActionResult & { range?: RangeInfo | null }> {
    let plan: Awaited<ReturnType<BvccAgentClient["planAddLiquidityV3Detailed"]>>;
    try {
      plan = await this.planAddLiquidityV3Detailed(params);
    } catch (e) {
      return fail("addLiquidityV3", planningFailure(e), this.ctx());
    }
    return { ...(await this.run("addLiquidityV3", plan.executions)), range: plan.range };
  }

  /** Build a collect-fees batch (recipient = wallet). */
  buildCollectFeesV3(tokenId: bigint, nfpm?: Address): Execution[] {
    return buildCollectV3({ nfpm: this.lpNfpm(nfpm), tokenId, recipient: this.walletAddress });
  }

  /** Collect owed fees to the wallet. Structured result. */
  collectFeesV3(tokenId: bigint, nfpm?: Address): Promise<ActionResult> {
    return this.run("collectFeesV3", this.buildCollectFeesV3(tokenId, nfpm));
  }

  /**
   * Build a remove-liquidity batch: `decreaseLiquidity` + `collect`, both to the
   * wallet. Pass an explicit `liquidity`, or a `bps` fraction (10000 = all) of the
   * position's current liquidity (read on-chain). `amount0Min`/`amount1Min` default
   * to 0 — set them for price protection. With `burn: true` and a full removal the
   * emptied NFT is burned in the same batch.
   */
  async buildRemoveLiquidityV3(params: {
    tokenId: bigint;
    liquidity?: bigint;
    bps?: number;
    amount0Min?: bigint;
    amount1Min?: bigint;
    burn?: boolean;
    deadline?: bigint;
    nfpm?: Address;
  }): Promise<Execution[]> {
    const nfpm = this.lpNfpm(params.nfpm);
    let liquidity = params.liquidity;
    let removingAll = false;
    if (liquidity == null) {
      const pos = await this.getV3Position(params.tokenId, nfpm);
      const bps = params.bps ?? 10000;
      if (bps <= 0 || bps > 10000) throw new Error("bps must be in (0, 10000].");
      liquidity = (pos.liquidity * BigInt(bps)) / 10000n;
      removingAll = bps === 10000;
    }
    if (liquidity <= 0n) throw new Error("Nothing to remove: position liquidity is 0.");
    const executions = buildDecreaseV3({
      nfpm,
      tokenId: params.tokenId,
      liquidity,
      amount0Min: params.amount0Min ?? 0n,
      amount1Min: params.amount1Min ?? 0n,
      recipient: this.walletAddress,
      deadline: params.deadline,
    });
    if (params.burn && removingAll) {
      executions.push(...buildBurnV3(nfpm, params.tokenId));
    }
    return executions;
  }

  /** Remove liquidity (decrease + collect, optional burn). Structured result. */
  async removeLiquidityV3(
    params: Parameters<BvccAgentClient["buildRemoveLiquidityV3"]>[0],
  ): Promise<ActionResult> {
    return this.run("removeLiquidityV3", await this.buildRemoveLiquidityV3(params));
  }

  /** Burn an already-empty position NFT. Structured result. */
  burnV3(tokenId: bigint, nfpm?: Address): Promise<ActionResult> {
    return this.run("burnV3", buildBurnV3(this.lpNfpm(nfpm), tokenId));
  }

  /** Dry-run: open a v3 position (amounts auto-balanced to the pool ratio). */
  async dryRunAddLiquidityV3(
    params: Parameters<BvccAgentClient["planAddLiquidityV3"]>[0],
  ): Promise<DryRunResult & { range?: RangeInfo | null }> {
    let plan: Awaited<ReturnType<BvccAgentClient["planAddLiquidityV3Detailed"]>>;
    try {
      plan = await this.planAddLiquidityV3Detailed(params);
    } catch (e) {
      const range = e instanceof OutOfRangeError ? e.range : undefined;
      return { ok: false, action: "addLiquidityV3", estimatedGas: null, estimatedNetworkFeeWei: null, preview: [], failure: planningFailure(e), range };
    }
    return { ...(await this.dryRun("addLiquidityV3", plan.executions)), range: plan.range };
  }

  /** Dry-run: remove liquidity. */
  async dryRunRemoveLiquidityV3(
    params: Parameters<BvccAgentClient["buildRemoveLiquidityV3"]>[0],
  ): Promise<DryRunResult> {
    return this.dryRun("removeLiquidityV3", await this.buildRemoveLiquidityV3(params));
  }

  /** Dry-run: collect fees. */
  dryRunCollectFeesV3(tokenId: bigint, nfpm?: Address): Promise<DryRunResult> {
    return this.dryRun("collectFeesV3", this.buildCollectFeesV3(tokenId, nfpm));
  }

  // ------------------------------------------------------------------
  // Uniswap v4 liquidity (PositionManager modifyLiquidities)
  // ------------------------------------------------------------------
  // Native-ETH LP lives here (currency0 = address(0)). Recipients are pinned to the
  // wallet by the BVCCPositionManagerValidator (DEEP). This FAILS CLOSED until that
  // validator is active in the registry (48h governance) and the owner has set the
  // DEEP policy on (PositionManager, modifyLiquidities) — until then, use v3.

  /** Resolve the v4 PositionManager for this chain (or override), else throw. */
  private lpPmV4(pm?: Address): Address {
    const a = pm ?? this.network.positionManagerV4;
    if (!a) throw new Error(`No Uniswap v4 PositionManager configured for ${this.network.name}. Pass { positionManager }.`);
    return a;
  }

  /** Read a v4 pool's current sqrtPriceX96 from the StateView (by poolId). */
  async getV4PoolSqrtPrice(key: V4PoolKey, stateView?: Address): Promise<bigint> {
    const sv = stateView ?? this.network.v4StateView;
    if (!sv) throw new Error(`No Uniswap v4 StateView configured for ${this.network.name}. Pass amounts sized to the pool.`);
    const slot0 = (await this.publicClient.readContract({
      address: sv,
      abi: v4StateViewAbi,
      functionName: "getSlot0",
      args: [v4PoolId(key)],
    })) as readonly [bigint, number, number, number];
    return slot0[0];
  }

  /** Read a v4 position's pool key and current liquidity. */
  async getV4Position(tokenId: bigint, pm?: Address): Promise<{ key: V4PoolKey; liquidity: bigint }> {
    const p = this.lpPmV4(pm);
    const res = (await this.publicClient.readContract({
      address: p,
      abi: v4PositionManagerReadAbi,
      functionName: "getPoolAndPositionInfo",
      args: [tokenId],
    })) as readonly [V4PoolKey, bigint];
    const liquidity = (await this.publicClient.readContract({
      address: p,
      abi: v4PositionManagerReadAbi,
      functionName: "getPositionLiquidity",
      args: [tokenId],
    })) as bigint;
    return { key: res[0], liquidity };
  }

  /**
   * Size a v4 mint from the pool's current price and build it. `tokenA`/`tokenB`
   * use `address(0)` for native ETH; the pair is sorted internally (native sorts to
   * currency0). Amounts are the MAXIMUMS; the actual amounts are matched to the pool
   * ratio. Range defaults to full-range for the tick spacing (from `fee` unless
   * `tickSpacing` is given). `hooks` defaults to none (address(0)); a hooked pool
   * only works if that hook is approved in the BVCCHookRegistry.
   */
  async planAddLiquidityV4(params: LiquidityRangeParams & {
    tokenA: Address;
    amountA: bigint;
    tokenB: Address;
    amountB: bigint;
    fee: number;
    tickSpacing?: number;
    hooks?: Address;
    tickLower?: number;
    tickUpper?: number;
    slippageBps?: number;
    deadline?: bigint;
    positionManager?: Address;
    stateView?: Address;
  }): Promise<Execution[]> {
    return (await this.planAddLiquidityV4Detailed(params)).executions;
  }

  /** {@link planAddLiquidityV4} plus the resolved range and its warnings (see the v3 one). */
  async planAddLiquidityV4Detailed(
    params: Parameters<BvccAgentClient["planAddLiquidityV4"]>[0],
  ): Promise<{ executions: Execution[]; range: RangeInfo | null }> {
    const pm = this.lpPmV4(params.positionManager);
    const tickSpacing = params.tickSpacing ?? feeToTickSpacing(params.fee);
    const hooks = params.hooks ?? V4_NATIVE;
    const { key, flipped } = orderV4Currencies(params.tokenA, params.tokenB, params.fee, tickSpacing, hooks);
    const amount0Max = flipped ? params.amountB : params.amountA;
    const amount1Max = flipped ? params.amountA : params.amountB;

    const aIsToken0 = !flipped;
    const [metaA, metaB] = await Promise.all([this.lpTokenMeta(params.tokenA), this.lpTokenMeta(params.tokenB)]);
    let tickLower: number;
    let tickUpper: number;
    let fullRange = false;
    const fromPrices = this.ticksFromPrices(params, metaA.decimals, metaB.decimals, aIsToken0);
    if (fromPrices) {
      tickLower = alignTickDown(fromPrices.tickLower, tickSpacing);
      tickUpper = alignTickUp(fromPrices.tickUpper, tickSpacing);
    } else if (params.tickLower != null && params.tickUpper != null) {
      tickLower = nearestUsableTick(params.tickLower, tickSpacing);
      tickUpper = nearestUsableTick(params.tickUpper, tickSpacing);
    } else {
      tickLower = alignTickUp(MIN_TICK, tickSpacing);
      tickUpper = alignTickDown(MAX_TICK, tickSpacing);
      fullRange = true;
    }
    if (tickLower >= tickUpper) throw new Error("tickLower must be < tickUpper after alignment.");

    const sqrtP = await this.getV4PoolSqrtPrice(key, params.stateView);
    const range = this.checkRange(sqrtP, tickLower, tickUpper, metaA, metaB, aIsToken0, fullRange, params.allowOutOfRange);
    const liquidity = getLiquidityForAmounts(
      sqrtP,
      getSqrtRatioAtTick(tickLower),
      getSqrtRatioAtTick(tickUpper),
      amount0Max,
      amount1Max,
    );
    if (liquidity <= 0n) throw new Error("Could not size any liquidity from the given amounts — increase one side.");

    const executions = buildMintV4({
      positionManager: pm,
      key,
      tickLower,
      tickUpper,
      liquidity,
      amount0Max,
      amount1Max,
      recipient: this.walletAddress,
      deadline: params.deadline,
    });
    return { executions, range };
  }

  /** Decimals and symbol for a pool currency (native = the chain's currency, 18). */
  private async lpTokenMeta(token: Address): Promise<{ decimals: number; symbol: string }> {
    if (token.toLowerCase() === V4_NATIVE.toLowerCase()) return { decimals: 18, symbol: this.network.currency };
    const b = await this.getTokenBalance(token);
    return { decimals: b.decimals, symbol: b.symbol };
  }

  /** priceLower/priceUpper → ticks, or null when the caller gave no prices. */
  private ticksFromPrices(
    p: LiquidityRangeParams,
    decimalsA: number,
    decimalsB: number,
    aIsToken0: boolean,
  ): { tickLower: number; tickUpper: number } | null {
    if (p.priceLower == null && p.priceUpper == null) return null;
    if (p.priceLower == null || p.priceUpper == null)
      throw new Error("Pass both priceLower and priceUpper (tokenA per tokenB), or neither.");
    return pricesToTicks(Number(p.priceLower), Number(p.priceUpper), decimalsA, decimalsB, aIsToken0);
  }

  /** Read a range against the pool price; refuse an out-of-range one unless allowed. */
  private checkRange(
    sqrtP: bigint,
    tickLower: number,
    tickUpper: number,
    metaA: { decimals: number; symbol: string },
    metaB: { decimals: number; symbol: string },
    aIsToken0: boolean,
    fullRange: boolean,
    allowOutOfRange?: boolean,
  ): RangeInfo {
    const range = describeRange({
      tickLower,
      tickUpper,
      currentTick: tickFromSqrtPrice(sqrtP),
      decimalsA: metaA.decimals,
      decimalsB: metaB.decimals,
      aIsToken0,
      symbolA: metaA.symbol,
      symbolB: metaB.symbol,
      fullRange,
    });
    if (!fullRange && !range.inRange && !allowOutOfRange) {
      throw new OutOfRangeError(range);
    }
    return range;
  }

  /** Open a v4 position (native ETH supported). Structured result. */
  async addLiquidityV4(
    params: Parameters<BvccAgentClient["planAddLiquidityV4"]>[0],
  ): Promise<ActionResult & { range?: RangeInfo | null }> {
    let plan: Awaited<ReturnType<BvccAgentClient["planAddLiquidityV4Detailed"]>>;
    try {
      plan = await this.planAddLiquidityV4Detailed(params);
    } catch (e) {
      return fail("addLiquidityV4", planningFailure(e), this.ctx());
    }
    return { ...(await this.run("addLiquidityV4", plan.executions)), range: plan.range };
  }

  /** Build a remove-liquidity (or burn) batch for a v4 position, proceeds to wallet. */
  async buildRemoveLiquidityV4(params: {
    tokenId: bigint;
    bps?: number;
    liquidity?: bigint;
    amount0Min?: bigint;
    amount1Min?: bigint;
    burn?: boolean;
    deadline?: bigint;
    positionManager?: Address;
  }): Promise<Execution[]> {
    const pm = this.lpPmV4(params.positionManager);
    const pos = await this.getV4Position(params.tokenId, pm);
    let liquidity = params.liquidity;
    let removingAll = false;
    if (liquidity == null) {
      const bps = params.bps ?? 10000;
      if (bps <= 0 || bps > 10000) throw new Error("bps must be in (0, 10000].");
      liquidity = (pos.liquidity * BigInt(bps)) / 10000n;
      removingAll = bps === 10000;
    }
    // BURN_POSITION removes any remaining liquidity and burns in one action.
    if (params.burn && removingAll) {
      return buildBurnV4({
        positionManager: pm,
        tokenId: params.tokenId,
        amount0Min: params.amount0Min ?? 0n,
        amount1Min: params.amount1Min ?? 0n,
        currency0: pos.key.currency0,
        currency1: pos.key.currency1,
        recipient: this.walletAddress,
        deadline: params.deadline,
      });
    }
    if (liquidity <= 0n) throw new Error("Nothing to remove: position liquidity is 0.");
    return buildDecreaseV4({
      positionManager: pm,
      tokenId: params.tokenId,
      liquidity,
      amount0Min: params.amount0Min ?? 0n,
      amount1Min: params.amount1Min ?? 0n,
      currency0: pos.key.currency0,
      currency1: pos.key.currency1,
      recipient: this.walletAddress,
      deadline: params.deadline,
    });
  }

  /** Remove v4 liquidity (decrease + take, optional burn). Structured result. */
  async removeLiquidityV4(
    params: Parameters<BvccAgentClient["buildRemoveLiquidityV4"]>[0],
  ): Promise<ActionResult> {
    return this.run("removeLiquidityV4", await this.buildRemoveLiquidityV4(params));
  }

  /** Collect a v4 position's fees to the wallet. Structured result. */
  async collectFeesV4(tokenId: bigint, pm?: Address): Promise<ActionResult> {
    const p = this.lpPmV4(pm);
    const pos = await this.getV4Position(tokenId, p);
    return this.run(
      "collectFeesV4",
      buildCollectV4({
        positionManager: p,
        tokenId,
        currency0: pos.key.currency0,
        currency1: pos.key.currency1,
        recipient: this.walletAddress,
      }),
    );
  }

  /** Burn a v4 position (removes remaining liquidity + burns), proceeds to wallet. */
  async burnV4(tokenId: bigint, pm?: Address): Promise<ActionResult> {
    const p = this.lpPmV4(pm);
    const pos = await this.getV4Position(tokenId, p);
    return this.run(
      "burnV4",
      buildBurnV4({
        positionManager: p,
        tokenId,
        amount0Min: 0n,
        amount1Min: 0n,
        currency0: pos.key.currency0,
        currency1: pos.key.currency1,
        recipient: this.walletAddress,
      }),
    );
  }

  /** Dry-run: open a v4 position. */
  async dryRunAddLiquidityV4(
    params: Parameters<BvccAgentClient["planAddLiquidityV4"]>[0],
  ): Promise<DryRunResult & { range?: RangeInfo | null }> {
    let plan: Awaited<ReturnType<BvccAgentClient["planAddLiquidityV4Detailed"]>>;
    try {
      plan = await this.planAddLiquidityV4Detailed(params);
    } catch (e) {
      const range = e instanceof OutOfRangeError ? e.range : undefined;
      return { ok: false, action: "addLiquidityV4", estimatedGas: null, estimatedNetworkFeeWei: null, preview: [], failure: planningFailure(e), range };
    }
    return { ...(await this.dryRun("addLiquidityV4", plan.executions)), range: plan.range };
  }

  /** Dry-run: remove v4 liquidity. */
  async dryRunRemoveLiquidityV4(
    params: Parameters<BvccAgentClient["buildRemoveLiquidityV4"]>[0],
  ): Promise<DryRunResult> {
    return this.dryRun("removeLiquidityV4", await this.buildRemoveLiquidityV4(params));
  }

  // ------------------------------------------------------------------
  // Aave v3 (lazy — only constructed when accessed)
  // ------------------------------------------------------------------

  private _aave?: AaveClient;

  /** Aave v3 lending operations for this wallet. Reverts if the chain has no Aave. */
  get aave(): AaveClient {
    return (this._aave ??= new AaveClient(this));
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  /** Read this agent's full on-chain permission struct. */
  async getPermission(agent: Address = this.agentAddress): Promise<AgentPermission> {
    if ((await this.walletVersion()) === "v5") {
      // V5 splits the struct: limits and flags here, spending in getAgentSpending.
      const [p, sp] = await Promise.all([
        this.publicClient.readContract({
          address: this.walletAddress,
          abi: agentWalletV5Abi,
          functionName: "getAgentPermission",
          args: [agent],
        }),
        this.publicClient.readContract({
          address: this.walletAddress,
          abi: agentWalletV5Abi,
          functionName: "getAgentSpending",
          args: [agent],
        }),
      ]);
      return {
        maxPerTxWei: p.maxPerTxWei,
        dailyLimitWei: p.dailyLimitWei,
        totalBudgetWei: p.totalBudgetWei,
        totalSpentWei: sp.totalSpentWei,
        periodBudgetWei: p.periodBudgetWei,
        periodSpentWei: sp.periodSpentWei,
        allowedTokens: p.allowedTokens,
        tokenMaxAmounts: p.tokenMaxAmounts,
        tokenDailyLimits: p.tokenDailyLimits,
        tokenTotalBudgets: p.tokenTotalBudgets,
        allowedProtocols: p.allowedProtocols,
        allowedRecipients: p.allowedRecipients,
        expiry: BigInt(p.expiry),
        periodDuration: BigInt(p.periodDuration),
        periodStart: BigInt(sp.periodStart),
        active: p.active,
        paused: p.paused,
      };
    }
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
    const v5 = (await this.walletVersion()) === "v5";
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
        dailyRemaining: remainingUnder(dailyLimit, dailySpent, v5),
        totalRemaining: remainingUnder(totalBudget, totalSpent, v5),
      });
    }

    return {
      active: perm.active,
      expired,
      maxPerTxWei: v5
        ? v5Unlimited(perm.maxPerTxWei) ? null : perm.maxPerTxWei
        : perm.maxPerTxWei === 0n ? null : perm.maxPerTxWei,
      dailyRemainingWei: remainingUnder(perm.dailyLimitWei, dailySpentNative, v5),
      totalRemainingWei: remainingUnder(perm.totalBudgetWei, perm.totalSpentWei, v5),
      periodRemainingWei: periodEnabled
        ? remainingUnder(perm.periodBudgetWei, periodSpent, v5)
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
    const v5 = (await this.walletVersion()) === "v5";
    const r = await this.getRemaining(agent);
    if (!r.active) return { ok: false, reason: "Agent is not active (revoked or never authorized)." };
    if (r.expired) return { ok: false, reason: "Agent permissions have expired." };
    if (await this.isPaused()) return { ok: false, reason: "All agents are paused on this wallet." };
    if (v5) {
      const perm = await this.getPermission(agent);
      if (perm.paused) return { ok: false, reason: "The owner has paused this agent." };
      if (perm.allowedRecipients.length === 0)
        return { ok: false, reason: "This agent has no allowed recipients, so it cannot send to anyone (wallet V5)." };
      // V5 limits count the 0.15% agent fee too.
      amountWei = withAgentFee(amountWei);
    }
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
    const v5 = (await this.walletVersion()) === "v5";
    const r = await this.getRemaining(agent);
    if (!r.active) return { ok: false, reason: "Agent is not active." };
    if (r.expired) return { ok: false, reason: "Agent permissions have expired." };
    const tb = r.tokens.find((t) => t.token.toLowerCase() === token.toLowerCase());
    if (!tb) return { ok: false, reason: `Token ${token} is not in the agent's allowedTokens whitelist.` };
    if (v5) {
      // V5: 0 allows nothing, max allows anything, and the agent fee counts too.
      amount = withAgentFee(amount);
      if (!v5Unlimited(tb.maxPerTx) && amount > tb.maxPerTx)
        return { ok: false, reason: `Exceeds per-operation token limit (${tb.maxPerTx}, fee included).` };
    } else if (tb.maxPerTx !== 0n && amount > tb.maxPerTx)
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
    let batch: Execution[];
    try {
      batch = await this.prepareBatch(executions);
    } catch (e) {
      return {
        ok: false,
        action,
        estimatedGas: null,
        estimatedNetworkFeeWei: null,
        preview: [],
        failure: decodeRevert(e),
      };
    }
    const preview = batch.map((e) => ({
      target: e.target,
      value: e.value,
      selector: (e.callData && e.callData !== "0x" ? slice(e.callData, 0, 4) : "0x") as Hex,
    }));
    const data = this.agentCalldata(batch);
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

  async dryRunSendNative(to: Address, amountWei: bigint): Promise<DryRunResult> {
    const short = await this.feeRoomShortfall("native", amountWei);
    if (short) return { ok: false, action: "sendNative", estimatedGas: null, estimatedNetworkFeeWei: null, preview: [], failure: short };
    return this.dryRun("sendNative", [this.buildSendNative(to, amountWei)]);
  }
  async dryRunSendToken(token: Address, to: Address, amount: bigint): Promise<DryRunResult> {
    const short = await this.feeRoomShortfall(token, amount);
    if (short) return { ok: false, action: "sendToken", estimatedGas: null, estimatedNetworkFeeWei: null, preview: [], failure: short };
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
    const [p, walletPaused, walletVersion] = await Promise.all([
      this.getPermission(agent),
      this.isPaused(),
      this.walletVersion(),
    ]);
    const isPaused = walletPaused || p.paused === true;
    const now = BigInt(Math.floor(Date.now() / 1000));
    return {
      walletVersion,
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

  /**
   * V5: what the agent can do. Every protocol call needs this agent's own policy, an
   * active validator and a target the owner has not blocked; swaps and v4 liquidity
   * also pull through Permit2 allowances the owner granted. All of it is read here,
   * so a `true` flag means the wallet is set up for that action.
   */
  private async getCapabilitiesV5(agent: Address): Promise<Capabilities> {
    const ur = this.network.universalRouter;
    const pm = this.network.positionManagerV4;
    const aave = getAaveAddresses(this.network.chainId)?.pool;
    const [p, walletPaused, registry] = await Promise.all([
      this.getPermission(agent),
      this.isPaused(),
      this.publicClient.readContract({
        address: this.walletAddress,
        abi: agentWalletV5Abi,
        functionName: "VALIDATOR_REGISTRY",
      }) as Promise<Address>,
    ]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const expired = p.expiry !== 0n && now >= p.expiry;
    const live = p.active && !expired && !walletPaused && p.paused !== true;
    const protos = p.allowedProtocols.map((a) => a.toLowerCase());
    const has = (a?: Address) => !!a && protos.includes(a.toLowerCase());
    const hasTokens = p.allowedTokens.length > 0;
    const hasRecipients = p.allowedRecipients.length > 0;
    const ethAllowed = p.maxPerTxWei !== 0n && p.dailyLimitWei !== 0n && p.totalBudgetWei !== 0n;

    // One protocol route: policy for this agent, a live validator, not blocked.
    const route = async (target: Address | undefined, selector: Hex) => {
      if (!target || !has(target)) return { ok: false, policy: null, validator: null, blocked: false };
      const [policy, validator, blocked] = await Promise.all([
        getPolicy(this.publicClient, this.walletAddress, target, selector, agent),
        getActiveValidator(this.publicClient, registry, target),
        this.publicClient.readContract({
          address: this.walletAddress,
          abi: agentWalletV5Abi,
          functionName: "isTargetBlocked",
          args: [target],
        }) as Promise<boolean>,
      ]);
      return { ok: policy.allowed && policy.deep && !!validator && !blocked, policy, validator, blocked };
    };
    const nfpm = this.network.nfpm;
    const weth = this.network.weth;
    const [rUr, rPm, rAave, rV3, rWrap] = await Promise.all([
      route(ur, SELECTORS.urExecute),
      route(pm, "0xdd46508f"),
      route(aave, "0x617ba037"),
      route(nfpm, "0x88316456"),
      route(weth, "0xd0e30db0"),
    ]);

    const notes: string[] = [];
    if (!p.active) notes.push("Agent is not active (revoked or never authorized).");
    if (expired) notes.push("Agent permissions have expired.");
    if (walletPaused) notes.push("All agents are paused on this wallet.");
    if (p.paused) notes.push("The owner has paused this agent.");
    notes.push(
      "Wallet V5: a limit of 0 allows nothing, limits include the 0.15% agent fee, and an empty recipient list means no recipient.",
    );
    if (!ethAllowed) notes.push("ETH limits are 0 — the agent cannot move ETH.");
    if (!hasRecipients) notes.push("No allowed recipients — the agent cannot send ETH or tokens to anyone.");
    if (!hasTokens) notes.push("No tokens whitelisted — token transfers, swaps and DeFi are denied.");

    const missingPolicies: MissingPolicy[] = [];
    const describe = (
      label: string,
      action: string,
      target: Address | undefined,
      selector: `0x${string}`,
      r: Awaited<ReturnType<typeof route>>,
    ) => {
      if (!target || !has(target)) return;
      if (r.blocked) notes.push(`The owner has blocked ${label} for every agent.`);
      if (r.policy && !(r.policy.allowed && r.policy.deep)) {
        missingPolicies.push({ action, protocol: target, selector, label });
      }
      if (!r.validator) notes.push(`No validator is active yet for ${label}; calls to it fail closed.`);
    };
    describe("the Universal Router", "swapV4", ur, SELECTORS.urExecute, rUr);
    describe("the Uniswap v4 PositionManager", "addLiquidityV4", pm, "0xdd46508f", rPm);
    describe("the Aave Pool", "aaveSupply", aave, "0x617ba037", rAave);
    describe("the Uniswap v3 position manager", "addLiquidityV3", nfpm, "0x88316456", rV3);
    describe("the wrapped native token", "swapFromNative", weth, "0xd0e30db0", rWrap);
    if (missingPolicies.length > 0)
      notes.push("Some call policies are missing for this agent. The owner adds them by editing the agent in the dashboard.");

    // Swaps pull through Permit2 allowances the owner granted when authorizing the agent.
    if (rUr.ok && ur) {
      const nowSec = Math.floor(Date.now() / 1000);
      const missing: string[] = [];
      for (const token of p.allowedTokens) {
        try {
          const a = await this.getPermit2Allowance(token, ur);
          if (a.amount === 0n || (a.expiration !== 0 && a.expiration <= nowSec)) missing.push(token);
        } catch {
          missing.push(token);
        }
      }
      if (missing.length > 0)
        notes.push(
          `No live Permit2 allowance to the Universal Router for ${missing.join(", ")}. The owner grants it by renewing the agent.`,
        );
    }
    notes.push(
      "Not available to agents on V5: SwapRouter02 (swaps are routed through the Universal Router automatically) and Aave repayWithATokens. " +
        "Uniswap v3 liquidity and wrapping the native coin work where their validators are active and the owner allowed them for this agent.",
    );

    const canSwap = live && hasTokens && rUr.ok;
    return {
      canSendNative: live && ethAllowed && hasRecipients,
      canSendTokens: live && hasTokens && hasRecipients,
      canApprove: live && hasTokens && p.allowedProtocols.length > 0,
      canSwapV3: canSwap,
      canSwapV4: canSwap,
      canProvideLiquidityV3: live && hasTokens && rV3.ok,
      canWrapNative: live && rWrap.ok,
      allowedSwapTokens: p.allowedTokens,
      allowedProtocols: p.allowedProtocols,
      notes,
      walletVersion: "v5",
      missingPolicies,
    };
  }

  /**
   * Derive what the agent can currently do.
   *
   * On V3 wallets the permission struct is only half the answer: Case-3 calls also
   * need a registered call policy per selector, and DEEP policies need a validator
   * live in the registry. Reporting `canSwapV4: true` off permissions alone sends
   * the agent into a guaranteed revert — and worse, it stays true after BVCC uses
   * the registry kill-switch. So on V3 the swap flags are also gated on policies.
   */
  async getCapabilities(agent: Address = this.agentAddress): Promise<Capabilities> {
    if ((await this.walletVersion()) === "v5") return this.getCapabilitiesV5(agent);
    const [p, isPaused, walletVersion] = await Promise.all([
      this.getPermission(agent),
      this.isPaused(),
      detectWalletVersion(this.publicClient, this.walletAddress),
    ]);
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

    let policyOkV3 = true;
    let policyOkV4 = true;
    const missingPolicies: MissingPolicy[] = [];

    // Every generation from V3 on has the call-policy layer.
    if (walletVersion !== "v2") {
      const registry = this.network.validatorRegistry;
      const router = this.network.swapRouter02;
      const ur = this.network.universalRouter;

      const [pSwap, pUr, pPermit2, urValidator] = await Promise.all([
        router ? getPolicy(this.publicClient, this.walletAddress, router, SELECTORS.exactInputSingle) : null,
        ur ? getPolicy(this.publicClient, this.walletAddress, ur, SELECTORS.urExecute) : null,
        getPolicy(this.publicClient, this.walletAddress, PERMIT2, SELECTORS.permit2Approve),
        registry && ur ? getActiveValidator(this.publicClient, registry, ur) : null,
      ]);

      if (router && pSwap && !pSwap.allowed) {
        policyOkV3 = false;
        missingPolicies.push({
          action: "swapV3",
          protocol: router,
          selector: SELECTORS.exactInputSingle,
          label: "SwapRouter02 exactInputSingle",
        });
      }
      if (ur && pUr && !pUr.allowed) {
        policyOkV4 = false;
        missingPolicies.push({
          action: "swapV4",
          protocol: ur,
          selector: SELECTORS.urExecute,
          label: "Universal Router execute",
        });
      }
      if (!pPermit2.allowed) {
        policyOkV4 = false;
        missingPolicies.push({
          action: "swapV4",
          protocol: PERMIT2,
          selector: SELECTORS.permit2Approve,
          label: "Permit2 approve",
        });
      }
      // A DEEP policy is inert without a live validator: the registry fails closed.
      if (ur && pUr?.allowed && pUr.deep && !urValidator) {
        policyOkV4 = false;
        notes.push(
          "No validator is active for the Universal Router — deep-validated swaps fail closed. Use SwapRouter02 (v3) instead.",
        );
      }
      if (missingPolicies.length > 0)
        notes.push(
          "Wallet V3: some call policies are missing. The owner must add these protocols to the agent in the dashboard.",
        );
    }

    return {
      canSendNative: live,
      canSendTokens: live && hasTokens,
      canApprove: live && hasTokens,
      canSwapV3: live && hasTokens && has(this.network.swapRouter02) && policyOkV3,
      canSwapV4: live && hasTokens && has(this.network.universalRouter) && hasPermit2 && policyOkV4,
      allowedSwapTokens: p.allowedTokens,
      allowedProtocols: p.allowedProtocols,
      notes,
      walletVersion,
      missingPolicies,
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
