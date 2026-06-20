import type { Address, PublicClient } from "viem";
import { quoterV2Abi, v4QuoterAbi } from "./abi.js";

/**
 * On-chain quoting helpers (no external APIs). These call the Uniswap Quoter
 * contracts read-only via `simulateContract`. They throw on failure — callers
 * such as `buildSwapPlan` catch and degrade to a warning rather than break.
 */

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** Apply slippage in basis points (e.g. 50 = 0.5%). */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (amountOut * (10_000n - bps)) / 10_000n;
}

/** Quote a Uniswap v3 exact-input single-hop swap. Returns amountOut. */
export async function quoteV3ExactInputSingle(
  publicClient: PublicClient,
  quoter: Address,
  params: { tokenIn: Address; tokenOut: Address; amountIn: bigint; fee: number },
): Promise<bigint> {
  const { result } = await publicClient.simulateContract({
    address: quoter,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn,
        fee: params.fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return (result as readonly bigint[])[0];
}

/** Quote a Uniswap v4 exact-input single-hop swap. Returns amountOut. */
export async function quoteV4ExactInputSingle(
  publicClient: PublicClient,
  quoter: Address,
  params: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    fee: number;
    tickSpacing: number;
    hooks?: Address;
  },
): Promise<bigint> {
  // v4 PoolKey requires currency0 < currency1; zeroForOne is the swap direction.
  const zeroForOne = params.tokenIn.toLowerCase() < params.tokenOut.toLowerCase();
  const [currency0, currency1] = zeroForOne
    ? [params.tokenIn, params.tokenOut]
    : [params.tokenOut, params.tokenIn];

  const { result } = await publicClient.simulateContract({
    address: quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: {
          currency0,
          currency1,
          fee: params.fee,
          tickSpacing: params.tickSpacing,
          hooks: params.hooks ?? ZERO,
        },
        zeroForOne,
        exactAmount: params.amountIn,
        hookData: "0x",
      },
    ],
  });
  return (result as readonly bigint[])[0];
}
