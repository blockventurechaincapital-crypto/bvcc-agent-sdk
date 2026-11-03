/**
 * Router deadlines against the chain's clock.
 *
 * The builders set a swap or liquidity deadline (Universal Router, v4 PositionManager,
 * Uniswap v3 NFPM mint / increase / decrease) from the computer's clock. When that
 * clock is behind, the deadline is already past on-chain and the router reverts
 * (`TransactionDeadlinePassed` / `DeadlinePassed`) — a failure the agent cannot
 * explain or fix by retrying. Right before sending, the client reads the latest
 * block's timestamp and moves any deadline that is already past (or about to be)
 * a few minutes into the chain's future. Deadlines that are still ahead are kept.
 */
import { decodeFunctionData, encodeFunctionData, slice, type Address } from "viem";

import { nfpmAbi } from "./abi.js";
import type { Execution } from "./types.js";

const UR_EXECUTE = "0x3593564c";
const PM_MODIFY = "0xdd46508f";
/** Uniswap v3 NFPM calls whose params struct ends with a deadline. */
const NFPM_WITH_DEADLINE = new Set(["0x88316456", "0x219f5d17", "0x0c49ccbe"]); // mint, increase, decrease
/** A deadline closer than this to the chain's time is treated as stale. */
const MIN_HEADROOM = 60n;
/** How far ahead a refreshed deadline is set. */
const FRESH_WINDOW = 20n * 60n;

const urAbi = [
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

const pmAbi = [
  {
    type: "function",
    name: "modifyLiquidities",
    stateMutability: "payable",
    inputs: [
      { name: "unlockData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function refreshStaleDeadlines(
  executions: Execution[],
  chainNow: bigint,
  targets: { universalRouter?: Address; positionManagerV4?: Address; nfpm?: Address },
): Execution[] {
  const fresh = chainNow + FRESH_WINDOW;
  return executions.map((e) => {
    if (!e.callData || e.callData.length < 10) return e;
    const sel = slice(e.callData, 0, 4).toLowerCase();
    try {
      if (sel === UR_EXECUTE && eq(e.target, targets.universalRouter)) {
        const { args } = decodeFunctionData({ abi: urAbi, data: e.callData });
        if (args[2] >= chainNow + MIN_HEADROOM) return e;
        return {
          ...e,
          callData: encodeFunctionData({ abi: urAbi, functionName: "execute", args: [args[0], args[1], fresh] }),
        };
      }
      if (sel === PM_MODIFY && eq(e.target, targets.positionManagerV4)) {
        const { args } = decodeFunctionData({ abi: pmAbi, data: e.callData });
        if (args[1] >= chainNow + MIN_HEADROOM) return e;
        return {
          ...e,
          callData: encodeFunctionData({ abi: pmAbi, functionName: "modifyLiquidities", args: [args[0], fresh] }),
        };
      }
      if (NFPM_WITH_DEADLINE.has(sel) && eq(e.target, targets.nfpm)) {
        const { functionName, args } = decodeFunctionData({ abi: nfpmAbi, data: e.callData });
        const params = (args as readonly [{ deadline: bigint }])[0];
        if (params.deadline >= chainNow + MIN_HEADROOM) return e;
        return {
          ...e,
          callData: encodeFunctionData({
            abi: nfpmAbi,
            functionName,
            args: [{ ...params, deadline: fresh }],
          } as Parameters<typeof encodeFunctionData>[0]),
        };
      }
    } catch {
      // Not the shape we know: leave it as it is.
    }
    return e;
  });
}
