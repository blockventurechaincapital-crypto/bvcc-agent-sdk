import type { Address, Hex } from "viem";
import type { ActionName } from "./results.js";
import type { DecodedRevert } from "./errors.js";

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
 * `AgentPermission` struct. In every limit, `0` means unlimited / disabled.
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
 * Computed remaining headroom for an agent. `null` for any limit set to 0
 * (unlimited / disabled) on-chain.
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
  allowedTokens: readonly Address[];
  allowedProtocols: readonly Address[];
  allowedRecipients: readonly Address[];
}

/** What the agent can currently do, derived from its on-chain permission. */
export interface Capabilities {
  canSendNative: boolean;
  canSendTokens: boolean;
  canApprove: boolean;
  canSwapV3: boolean;
  canSwapV4: boolean;
  allowedSwapTokens: readonly Address[];
  allowedProtocols: readonly Address[];
  notes: string[];
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
