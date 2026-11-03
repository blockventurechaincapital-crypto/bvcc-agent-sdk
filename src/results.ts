import type { Address, Hex } from "viem";
import type { DecodedRevert } from "./errors.js";

/** Logical action a result describes — stable identifiers for MCP/Hermes. */
export type ActionName =
  | "sendNative"
  | "sendToken"
  | "approve"
  | "swapV3"
  | "swapV4"
  | "swapUniversalRouter"
  | "swapToNative"
  | "swapFromNative"
  | "addLiquidityV3"
  | "removeLiquidityV3"
  | "collectFeesV3"
  | "burnV3"
  | "addLiquidityV4"
  | "removeLiquidityV4"
  | "collectFeesV4"
  | "burnV4"
  | "execute"
  | "aaveSupply"
  | "aaveWithdraw"
  | "aaveBorrow"
  | "aaveRepay"
  | "aaveRepayWithATokens"
  | "aaveSetCollateral"
  | "aaveSetEMode";

export interface ActionContext {
  network: string;
  chainId: number;
  walletAddress: Address;
  agentAddress: Address;
}

export interface ActionSuccess extends ActionContext {
  ok: true;
  action: ActionName;
  txHash: Hex;
}

export interface ActionFailure extends ActionContext {
  ok: false;
  action: ActionName;
  errorName: string | null;
  humanMessage: string;
  suggestedAction: string;
  /** Selector or short message — never contains secrets. */
  rawError: string;
  /** false: the same call will fail again — do not repeat it with the same parameters. */
  retryable: boolean;
}

export type ActionResult = ActionSuccess | ActionFailure;

export function ok(action: ActionName, txHash: Hex, ctx: ActionContext): ActionSuccess {
  return { ok: true, action, txHash, ...ctx };
}

export function fail(action: ActionName, decoded: DecodedRevert, ctx: ActionContext): ActionFailure {
  return {
    ok: false,
    action,
    errorName: decoded.errorName,
    humanMessage: decoded.humanMessage,
    suggestedAction: decoded.suggestedAction,
    rawError: decoded.rawError,
    retryable: decoded.retryable,
    ...ctx,
  };
}
