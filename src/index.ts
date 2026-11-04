export { BvccAgentClient, BATCH_MODE, ZERO_ADDRESS } from "./client.js";
export type { BvccAgentClientOptions } from "./client.js";
export { NETWORKS, getNetwork, V5_ADDRESSES } from "./networks.js";
export type { BvccNetwork } from "./networks.js";
export {
  agentWalletAbi,
  agentWalletV5Abi,
  validatorRegistryAbi,
  validatorRegistryV5Abi,
  erc20Abi,
  swapRouter02Abi,
  permit2AllowanceAbi,
  quoterV2Abi,
  v4QuoterAbi,
  nfpmAbi,
  v3FactoryAbi,
  v3PoolAbi,
  v4StateViewAbi,
  v4PositionManagerReadAbi,
} from "./abi.js";

// V3 call policies
export {
  POLICY_ALLOWED,
  POLICY_DEEP,
  SELECTORS,
  decodePolicy,
  describePolicy,
  detectWalletVersion,
  isV5,
  readCallPolicy,
  getPolicy,
  getActiveValidator,
  wouldPassDeepValidation,
  diagnosePolicy,
} from "./policy.js";
export type { DecodedPolicy, WalletVersion, PolicyDiagnosis } from "./policy.js";
export {
  adaptBatchForV5,
  remainingUnder,
  withAgentFee,
  v5Unlimited,
  V5UnsupportedError,
  UINT128_MAX,
} from "./v5.js";
export type { V5Context } from "./v5.js";
export { refreshStaleDeadlines } from "./deadlines.js";
export { encodeSourceTag, decodeSourceTag, SOURCE_TAG_MAGIC, DEFAULT_SOURCE } from "./sourceTag.js";
export type { SourceTagOptions, SourceTool } from "./sourceTag.js";
export { SDK_VERSION } from "./version.js";
export {
  checkForUpdate,
  isNewerVersion,
  updateCheckDisabled,
  resetUpdateCheck,
  SDK_UPDATE_TARGET,
} from "./updateCheck.js";
export type { UpdateCheckTarget, UpdateAvailable, CheckForUpdateOptions, FetchLike } from "./updateCheck.js";

// Native ETH swaps (own batches via SwapRouter02 + WETH)
export {
  buildTokenToNative,
  buildNativeToToken,
  netOfFee,
  grossForNet,
  BVCC_FEE_BPS,
  ETH_TO_TOKEN_FEE_NOTE,
} from "./nativeSwap.js";
export type { TokenToNativeParams, NativeToTokenParams } from "./nativeSwap.js";

// Aave v3 — reads + risk calculators
export {
  resolveAave,
  getAccountData,
  getUserPositions,
  getReserves,
  maxSafeBorrowBase,
  maxSafeWithdrawBase,
  repayToReachHFBase,
  getAaveAddresses,
  AAVE,
  buildSupply,
  buildWithdraw,
  buildBorrow,
  buildRepay,
  buildRepayWithATokens,
  buildSetCollateral,
  buildSetEMode,
  MAX_UINT256,
  AaveClient,
} from "./aave/index.js";
export type {
  AaveAccountData,
  AaveUserPosition,
  AaveReserveInfo,
  RiskInput,
  AaveAddresses,
} from "./aave/index.js";
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

// Uniswap v3 liquidity (LP) builders + range math
export {
  buildMintV3,
  buildDecreaseV3,
  buildCollectV3,
  buildBurnV3,
  orderV3Tokens,
  MAX_UINT128,
} from "./lp/v3.js";
export type { MintV3Params, DecreaseV3Params, CollectV3Params } from "./lp/v3.js";
export {
  buildMintV4,
  buildIncreaseV4,
  buildDecreaseV4,
  buildCollectV4,
  buildBurnV4,
  orderV4Currencies,
  poolId as v4PoolId,
  NATIVE as V4_NATIVE,
} from "./lp/v4.js";
export type {
  MintV4Params,
  IncreaseV4Params,
  DecreaseV4Params,
  BurnV4Params,
  V4PoolKey,
} from "./lp/v4.js";
export {
  feeToTickSpacing,
  fullRangeTicks,
  nearestUsableTick,
  alignTickDown,
  alignTickUp,
  getSqrtRatioAtTick,
  amountsForLiquidity,
  getLiquidityForAmount0,
  getLiquidityForAmount1,
  getLiquidityForAmounts,
  minusSlippage,
  MIN_TICK,
  MAX_TICK,
} from "./lp/tickMath.js";
export type {
  MissingPolicy,
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
export { getGuide, listGuides, GUIDES } from "./guides.js";
export type { Guide, GuideArea, GuideSummary } from "./guides.js";
export type { TokenInfo, ResolvedToken } from "./tokens.js";

// On-chain quoting
export { applySlippage, quoteV3ExactInputSingle, quoteV4ExactInputSingle } from "./quote.js";

// Re-export common viem unit helpers so consumers don't need a second import.
export { parseEther, formatEther, parseUnits, formatUnits, isAddress } from "viem";
