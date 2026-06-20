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
  | "execute";

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
    ...ctx,
  };
}
