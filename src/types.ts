import type { Address, Hex } from "viem";
import type { ActionName } from "./results.js";
import type { DecodedRevert } from "./errors.js";
import type { UpdateAvailable } from "./updateCheck.js";

/** A single call the wallet will perform (ERC-7579 / ERC-7821 batch item). */
export interface Execution {
  /** Call target. Must respect the agent's whitelists (recipient / token / protocol). */
  target: Address;
  /** Native value (wei) to send with the call. */
  value: bigint;
  /** Calldata. `0x` for a plain ETH transfer. */
  callData: Hex;
}

/**
 * On-chain permission set for an agent, mirroring the contract's
 * `AgentPermission` struct.
 *
 * The meaning of a limit depends on the wallet generation:
 *   - V2–V4: `0` means unlimited / disabled.
 *   - V5: `0` means nothing is allowed, and `type(uint128).max` means unlimited. An
 *     empty `allowedRecipients` means no recipient. Limits include the 0.15% agent fee.
 * On V5 the spending fields are filled from `getAgentSpending`.
 */
export interface AgentPermission {
  maxPerTxWei: bigint;
  dailyLimitWei: bigint;
  totalBudgetWei: bigint;
  totalSpentWei: bigint;
  periodBudgetWei: bigint;
  periodSpentWei: bigint;
  allowedTokens: readonly Address[];
  tokenMaxAmounts: readonly bigint[];
  tokenDailyLimits: readonly bigint[];
  tokenTotalBudgets: readonly bigint[];
  allowedProtocols: readonly Address[];
  allowedRecipients: readonly Address[];
  expiry: bigint;
  periodDuration: bigint;
  periodStart: bigint;
  active: boolean;
  /** V5 only: this agent alone is paused by the owner. Always false before V5. */
  paused?: boolean;
}

/** Per-token budget snapshot, derived from the on-chain permission + spend. */
export interface TokenBudget {
  token: Address;
  maxPerTx: bigint;
  dailyLimit: bigint;
  totalBudget: bigint;
  dailySpent: bigint;
  totalSpent: bigint;
  /** dailyLimit - dailySpent, or null when unlimited. */
  dailyRemaining: bigint | null;
  /** totalBudget - totalSpent, or null when unlimited. */
  totalRemaining: bigint | null;
}

/**
 * Computed remaining headroom for an agent. `null` means that limit does not
 * restrict: a 0 limit before V5, `type(uint128).max` on V5. On V5 a 0 limit reads
 * as `0n` remaining — nothing is allowed.
 */
export interface RemainingBudget {
  active: boolean;
  expired: boolean;
  maxPerTxWei: bigint | null;
  dailyRemainingWei: bigint | null;
  totalRemainingWei: bigint | null;
  periodRemainingWei: bigint | null;
  /** Seconds until the current rolling period rolls over, or null if disabled. */
  periodResetsInSeconds: bigint | null;
  tokens: TokenBudget[];
}

/** Result of a preflight check before submitting an execution. */
export interface PreflightResult {
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
}

/** High-level snapshot of the agent's on-chain authorization. */
export interface AgentStatus {
  walletAddress: Address;
  agentAddress: Address;
  network: string;
  chainId: number;
  isAuthorized: boolean;
  isExpired: boolean;
  isPaused: boolean;
  /** Unix seconds; 0 = never expires. */
  expiry: bigint;
  /** Wallet generation, when known. */
  walletVersion?: "v2" | "v3" | "v4" | "v5";
  allowedTokens: readonly Address[];
  allowedProtocols: readonly Address[];
  allowedRecipients: readonly Address[];
  /** Present when a newer version of the SDK (or the MCP) is published on npm. */
  updateAvailable?: UpdateAvailable;
}

/** What the agent can currently do, derived from its on-chain permission. */
/** A call policy an action needs but the wallet has not registered. */
export interface MissingPolicy {
  /** Action this blocks, e.g. "swapV4". */
  action: string;
  /** Protocol the call targets. */
  protocol: Address;
  /** Function selector with no allowed policy. */
  selector: `0x${string}`;
  /** Human label for the function, e.g. "Universal Router execute". */
  label: string;
}

export interface Capabilities {
  canSendNative: boolean;
  canSendTokens: boolean;
  canApprove: boolean;
  canSwapV3: boolean;
  canSwapV4: boolean;
  /** Wallet V5: Uniswap v3 liquidity is usable (validator active, policy set, not blocked). */
  canProvideLiquidityV3?: boolean;
  /** Wallet V5: wrapping / unwrapping the native coin is usable (validator active, policy set). */
  canWrapNative?: boolean;
  allowedSwapTokens: readonly Address[];
  allowedProtocols: readonly Address[];
  notes: string[];
  /**
   * Which wallet generation this is. V3 enforces call policies on top of the
   * permission struct; V2 does not, so the policy fields below stay empty there.
   */
  walletVersion?: "v2" | "v3" | "v4" | "v5";
  /**
   * Policies an action needs but that are not registered. Non-empty means the
   * matching `can*` flag is false for a reason the permission struct alone would
   * not reveal.
   */
  missingPolicies?: MissingPolicy[];
}

/** A native or ERC-20 balance, formatted for display. */
export interface Balance {
  token: Address | "native";
  symbol: string;
  decimals: number;
  raw: bigint;
  formatted: string;
}

/** Result of a dry-run: simulation + gas estimate, no broadcast. */
export interface DryRunResult {
  ok: boolean;
  action: ActionName;
  estimatedGas: bigint | null;
  estimatedNetworkFeeWei: bigint | null;
  preview: { target: Address; value: bigint; selector: Hex }[];
  failure: DecodedRevert | null;
}

/** A planned swap (not submitted). `amountOutMinimum` is null unless quoted. */
export interface SwapPlan {
  protocol: "v3" | "v4";
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOutMinimum: bigint | null;
  fee: number;
  tickSpacing: number | null;
  hops: Address[];
  requiredProtocols: Address[];
  requiredTokens: Address[];
  needsApproval: boolean;
  estimatedGas: bigint | null;
  warnings: string[];
}
