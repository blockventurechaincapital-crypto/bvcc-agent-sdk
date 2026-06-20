export { BvccAgentClient, BATCH_MODE, ZERO_ADDRESS } from "./client.js";
export type { BvccAgentClientOptions } from "./client.js";
export { NETWORKS, getNetwork } from "./networks.js";
export type { BvccNetwork } from "./networks.js";
export {
  agentWalletAbi,
  erc20Abi,
  swapRouter02Abi,
  permit2AllowanceAbi,
  quoterV2Abi,
  v4QuoterAbi,
} from "./abi.js";
export {
  buildUniversalRouterSwap,
  encodeV3Path,
  PERMIT2,
  MSG_SENDER,
  ADDRESS_THIS,
} from "./universalRouter.js";
export type { UniversalRouterSwapParams } from "./universalRouter.js";
export { buildV4SwapExactIn } from "./universalRouterV4.js";
export type { V4SwapExactInParams, V4PathKey } from "./universalRouterV4.js";
export type {
  Execution,
  AgentPermission,
  TokenBudget,
  RemainingBudget,
  PreflightResult,
  AgentStatus,
  Capabilities,
  Balance,
  DryRunResult,
  SwapPlan,
} from "./types.js";

// Error decoding
export { decodeRevert, agentErrorAbi } from "./errors.js";
export type { DecodedRevert } from "./errors.js";

// Structured results
export { ok, fail } from "./results.js";
export type { ActionResult, ActionSuccess, ActionFailure, ActionName, ActionContext } from "./results.js";

// Token registry
export { TOKENS, resolveToken } from "./tokens.js";
export type { TokenInfo, ResolvedToken } from "./tokens.js";

// On-chain quoting
export { applySlippage, quoteV3ExactInputSingle, quoteV4ExactInputSingle } from "./quote.js";

// Re-export common viem unit helpers so consumers don't need a second import.
export { parseEther, formatEther, parseUnits, formatUnits, isAddress } from "viem";
