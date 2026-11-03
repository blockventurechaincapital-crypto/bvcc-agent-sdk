/**
 * Wallet V5 — the rules that differ from earlier generations, in one place.
 *
 * Limits
 *   V2–V4: a limit of 0 means unlimited.
 *   V5:    a limit of 0 means nothing is allowed; `type(uint128).max` means
 *          unlimited. Limits include the 0.15% agent fee.
 *
 * Execution
 *   Every protocol call needs an on-chain validator: the Universal Router, the
 *   Uniswap v4 PositionManager, the Aave Pool, and — where their validators are
 *   active — the Uniswap v3 NonfungiblePositionManager and the wrapped native token
 *   (wrap / unwrap). Permit2 allowances for the router and the PositionManager are
 *   granted by the owner, so the agent must not try to grant them itself (that call
 *   is refused). SwapRouter02 and Aave's `repayWithATokens` are not available.
 *
 * `adaptBatchForV5` turns a batch built by the generation-neutral builders into
 * one a V5 wallet accepts, and refuses with a clear message what V5 cannot do. The
 * client applies it right before sending or simulating, so callers keep using the
 * same builders on every generation.
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  slice,
  type Address,
  type Hex,
} from "viem";

import { swapRouter02Abi } from "./abi.js";
import type { DecodedRevert } from "./errors.js";
import type { Execution } from "./types.js";
import { PERMIT2 } from "./universalRouter.js";

export const UINT128_MAX = (1n << 128n) - 1n;

/** V5 agent fee: 0.15% of what leaves the wallet, rounded down. */
export const V5_AGENT_FEE_NUMERATOR = 1_500n;
export const V5_FEE_DENOMINATOR = 1_000_000n;

/** What a V5 limit charges for moving `amount`: the amount plus the agent fee. */
export function withAgentFee(amount: bigint): bigint {
  return amount + (amount * V5_AGENT_FEE_NUMERATOR) / V5_FEE_DENOMINATOR;
}

/** Whether a V5 limit lets anything through at all. */
export function v5LimitAllowsAnything(limit: bigint): boolean {
  return limit !== 0n;
}

/** Whether a V5 limit does not restrict. */
export function v5Unlimited(limit: bigint): boolean {
  return limit === UINT128_MAX;
}

/**
 * Remaining headroom under one limit. `null` = does not restrict.
 * V5: 0 → 0n (nothing allowed), max → null. Earlier generations: 0 → null.
 */
export function remainingUnder(limit: bigint, spent: bigint, v5: boolean): bigint | null {
  if (v5) {
    if (v5Unlimited(limit)) return null;
    return limit > spent ? limit - spent : 0n;
  }
  if (limit === 0n) return null;
  return limit > spent ? limit - spent : 0n;
}

/** A batch item V5 cannot run, with the reason in words. */
export class V5UnsupportedError extends Error {
  readonly bvccDecoded: DecodedRevert;
  constructor(humanMessage: string, suggestedAction: string) {
    super(humanMessage);
    this.name = "V5UnsupportedError";
    this.bvccDecoded = {
      errorName: "V5Unsupported",
      humanMessage,
      suggestedAction,
      rawError: "not available on wallet V5",
      retryable: false,
    };
  }
}

const SEL = {
  erc20Approve: "0x095ea7b3",
  permit2Approve: "0x87517c45",
  exactInputSingle: "0x04e45aaf",
  exactOutputSingle: "0x5023b4df",
  exactInput: "0xb858183f",
  exactOutput: "0x09b81346",
  wethDeposit: "0xd0e30db0",
  wethWithdraw: "0x2e1a7d4d",
  aaveRepayWithATokens: "0x2dad97d4",
} as const;

const urExecuteAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const V3_SWAP_EXACT_IN = "0x00";
const V3_SWAP_EXACT_OUT = "0x01";
const SWAP_DEADLINE_SECONDS = 20n * 60n;

export interface V5Context {
  wallet: Address;
  /** A validator for the Uniswap v3 NFPM is active on this network. */
  v3LiquidityActive?: boolean;
  /** A validator for the wrapped native token (wrap / unwrap) is active on this network. */
  wrapActive?: boolean;
  universalRouter?: Address;
  swapRouter02?: Address;
  nfpm?: Address;
  weth?: Address;
  /** Unix seconds used for the router deadline; defaults to now. */
  now?: bigint;
}

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const selectorOf = (data: Hex): string => (data && data.length >= 10 ? slice(data, 0, 4).toLowerCase() : "0x");

/** Spender of an ERC-20 `approve`, or null when the call is not one. */
function approveSpender(e: Execution): Address | null {
  if (selectorOf(e.callData) !== SEL.erc20Approve) return null;
  return ("0x" + e.callData.slice(34, 74)) as Address;
}

function v3SwapInput(recipient: Address, amount: bigint, limit: bigint, path: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }],
    [recipient, amount, limit, path, true],
  );
}

function urCall(router: Address, command: Hex, input: Hex, deadline: bigint): Execution {
  return {
    target: router,
    value: 0n,
    callData: encodeFunctionData({ abi: urExecuteAbi, functionName: "execute", args: [command, [input], deadline] }),
  };
}

/** A SwapRouter02 swap, re-expressed as the equivalent Universal Router v3 swap. */
function routeThroughUniversalRouter(e: Execution, ctx: V5Context): Execution {
  const router = ctx.universalRouter;
  if (!router) {
    throw new V5UnsupportedError(
      "SwapRouter02 is not available to agents on wallet V5, and no Universal Router is configured for this network.",
      "Use a network with a Universal Router, or pass one in the network config.",
    );
  }
  if (e.value !== 0n) {
    throw new V5UnsupportedError(
      "Swaps with native ETH are not available to agents on wallet V5.",
      "Swap with WETH instead; the owner can wrap or unwrap ETH from the dashboard.",
    );
  }
  const deadline = (ctx.now ?? BigInt(Math.floor(Date.now() / 1000))) + SWAP_DEADLINE_SECONDS;
  let decoded: ReturnType<typeof decodeFunctionData<typeof swapRouter02Abi>>;
  try {
    decoded = decodeFunctionData({ abi: swapRouter02Abi, data: e.callData });
  } catch {
    throw new V5UnsupportedError(
      "This SwapRouter02 call is not available to agents on wallet V5.",
      "Use a single swap through the Universal Router instead.",
    );
  }
  const { functionName, args } = decoded;
  const p = (args as readonly [Record<string, unknown>])[0];
  const recipient = p.recipient as Address;
  if (!eq(recipient, ctx.wallet)) {
    throw new V5UnsupportedError(
      "The swap sends its output to an address other than the wallet, which V5 refuses.",
      "Send every swap output back to the wallet.",
    );
  }
  switch (functionName) {
    case "exactInputSingle":
      return urCall(
        router,
        V3_SWAP_EXACT_IN,
        v3SwapInput(
          ctx.wallet,
          p.amountIn as bigint,
          p.amountOutMinimum as bigint,
          encodePacked(["address", "uint24", "address"], [p.tokenIn as Address, Number(p.fee), p.tokenOut as Address]),
        ),
        deadline,
      );
    case "exactOutputSingle":
      // The router's exact-output path runs from the output token back to the input.
      return urCall(
        router,
        V3_SWAP_EXACT_OUT,
        v3SwapInput(
          ctx.wallet,
          p.amountOut as bigint,
          p.amountInMaximum as bigint,
          encodePacked(["address", "uint24", "address"], [p.tokenOut as Address, Number(p.fee), p.tokenIn as Address]),
        ),
        deadline,
      );
    case "exactInput":
      return urCall(
        router,
        V3_SWAP_EXACT_IN,
        v3SwapInput(ctx.wallet, p.amountIn as bigint, p.amountOutMinimum as bigint, p.path as Hex),
        deadline,
      );
    case "exactOutput":
      return urCall(
        router,
        V3_SWAP_EXACT_OUT,
        v3SwapInput(ctx.wallet, p.amountOut as bigint, p.amountInMaximum as bigint, p.path as Hex),
        deadline,
      );
    default:
      throw new V5UnsupportedError(
        `SwapRouter02 ${functionName} is not available to agents on wallet V5.`,
        "Use a single swap through the Universal Router instead.",
      );
  }
}

/**
 * Make a batch acceptable to a V5 wallet, or refuse it with a clear reason.
 *
 *   - drops the agent's own Permit2 grants (`approve(Permit2)` and `Permit2.approve`):
 *     on V5 the owner grants them, and the wallet refuses the agent's;
 *   - drops approvals to SwapRouter02 and re-expresses its swaps through the
 *     Universal Router (V3_SWAP_EXACT_IN / V3_SWAP_EXACT_OUT), which pulls through
 *     the owner's Permit2 allowance;
 *   - lets wrap / unwrap and Uniswap v3 liquidity through only where their validators
 *     are active, and refuses Aave `repayWithATokens`.
 *
 * Everything else passes through untouched: the wallet stays the judge.
 */
export function adaptBatchForV5(executions: Execution[], ctx: V5Context): Execution[] {
  const out: Execution[] = [];
  for (const e of executions) {
    const sel = selectorOf(e.callData);
    const spender = approveSpender(e);

    if (spender && eq(spender, PERMIT2)) continue;
    if (eq(e.target, PERMIT2) && sel === SEL.permit2Approve) continue;
    if (spender && eq(spender, ctx.swapRouter02)) continue;

    if (eq(e.target, ctx.swapRouter02)) {
      out.push(routeThroughUniversalRouter(e, ctx));
      continue;
    }
    if (eq(e.target, ctx.weth) && (sel === SEL.wethDeposit || sel === SEL.wethWithdraw)) {
      if (!ctx.wrapActive) {
        throw new V5UnsupportedError(
          "Wrapping or unwrapping the native coin is not active yet for agents on this network (wallet V5).",
          "Use the wrapped token directly for now. The owner can wrap or unwrap from the dashboard.",
        );
      }
      out.push(e);
      continue;
    }
    if (eq(e.target, ctx.nfpm)) {
      if (!ctx.v3LiquidityActive) {
        throw new V5UnsupportedError(
          "Uniswap v3 liquidity is not active yet for agents on this network (wallet V5).",
          "Use Uniswap v4 liquidity for now.",
        );
      }
      out.push(e);
      continue;
    }
    if (sel === SEL.aaveRepayWithATokens) {
      throw new V5UnsupportedError(
        "Aave repayWithATokens is not available to agents on wallet V5.",
        "Withdraw the underlying asset and repay with it in the same batch.",
      );
    }
    out.push(e);
  }
  if (out.length === 0 && executions.length > 0) {
    throw new V5UnsupportedError(
      "Nothing left to run: on wallet V5 the Permit2 approvals are granted by the owner, not the agent.",
      "Skip the approval step; ask the owner to authorize the agent if the swap reports a missing allowance.",
    );
  }
  return out;
}
