/**
 * Native ETH swaps via SwapRouter02 + WETH, as BVCC's own batches.
 *
 * Why not the Universal Router: its native legs (WRAP_ETH / UNWRAP_WETH) route the
 * output through ADDRESS_THIS, which the BVCC validator denies — output held by the
 * router is sweepable by an attacker, so it is deliberately out of scope. These
 * batches instead keep every hop's recipient as the wallet, which the policy layer
 * can pin, and do the wrap/unwrap as explicit WETH calls.
 *
 * Fee shape (measured on a fork): the BVCC agent fee is
 * charged on Case-3 balance increases into the wallet. token → ETH: the swap lands
 * WETH in the wallet (charged there); `WETH.withdraw` then unwraps to ETH, and
 * exact-output avoids leftover WETH dust. ETH → token: `WETH.deposit` increases the
 * wallet's WETH and the swap then credits the output token.
 */
import { encodeFunctionData, type Address } from "viem";

import { erc20Abi, swapRouter02Abi } from "./abi.js";
import type { Execution } from "./types.js";

/** BVCC agent fee, in basis points, charged on Case-3 balance increases. */
export const BVCC_FEE_BPS = 15n;

export const ETH_TO_TOKEN_FEE_NOTE = "ETH→token swaps apply the 0.15% BVCC agent fee.";

const wethAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const;

const approve = (token: Address, spender: Address, amount: bigint): Execution => ({
  target: token,
  value: 0n,
  callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
});

/** Subtract the BVCC fee from a gross amount the wallet is about to receive. */
export function netOfFee(gross: bigint): bigint {
  return gross - (gross * BVCC_FEE_BPS) / 10000n;
}

/** Add the BVCC fee on top, so the wallet ends up with `net` after the cut. */
export function grossForNet(net: bigint): bigint {
  // ceil division so rounding never leaves the wallet a wei short.
  return (net * 10000n + (10000n - BVCC_FEE_BPS - 1n)) / (10000n - BVCC_FEE_BPS);
}

export interface TokenToNativeParams {
  router: Address;
  wallet: Address;
  weth: Address;
  tokenIn: Address;
  /** Exact ETH the wallet should end up with. */
  amountOut: bigint;
  /** Cap on tokenIn spent. */
  amountInMaximum: bigint;
  fee?: number;
}

/**
 * token → ETH: `[approve, exactOutputSingle → WETH (recipient = wallet), WETH.withdraw]`.
 *
 * Exact-output is what makes this clean: we ask the pool for exactly the WETH we
 * need, so nothing is left stranded. Because the swap output pays the 0.15% fee,
 * the pool must deliver slightly more than the target — `grossForNet` sizes that —
 * and the unwrap then takes exactly `amountOut`.
 */
export function buildTokenToNative(p: TokenToNativeParams): Execution[] {
  const gross = grossForNet(p.amountOut);
  const swapData = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactOutputSingle",
    args: [
      {
        tokenIn: p.tokenIn,
        tokenOut: p.weth,
        fee: p.fee ?? 3000,
        recipient: p.wallet,
        amountOut: gross,
        amountInMaximum: p.amountInMaximum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return [
    approve(p.tokenIn, p.router, p.amountInMaximum),
    { target: p.router, value: 0n, callData: swapData },
    {
      target: p.weth,
      value: 0n,
      callData: encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [p.amountOut] }),
    },
  ];
}

export interface NativeToTokenParams {
  router: Address;
  wallet: Address;
  weth: Address;
  tokenOut: Address;
  /** ETH to spend (the value sent to WETH.deposit). */
  amountIn: bigint;
  amountOutMinimum: bigint;
  fee?: number;
}

/**
 * ETH → token: `[WETH.deposit{value}, approve, exactInputSingle (recipient = wallet)]`.
 *
 * The deposit is a Case-3 call that increases the wallet's WETH, so the wallet keeps
 * only `netOfFee(amountIn)` — the swap must therefore be sized to that net figure,
 * not to the ETH sent, or the batch reverts for insufficient balance.
 */
export function buildNativeToToken(p: NativeToTokenParams): Execution[] {
  const swappable = netOfFee(p.amountIn);
  const swapData = encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: p.weth,
        tokenOut: p.tokenOut,
        fee: p.fee ?? 3000,
        recipient: p.wallet,
        amountIn: swappable,
        amountOutMinimum: p.amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return [
    {
      target: p.weth,
      value: p.amountIn,
      callData: encodeFunctionData({ abi: wethAbi, functionName: "deposit", args: [] }),
    },
    approve(p.weth, p.router, swappable),
    { target: p.router, value: 0n, callData: swapData },
  ];
}
