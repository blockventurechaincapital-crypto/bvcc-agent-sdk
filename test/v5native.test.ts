import { describe, expect, it } from "vitest";
import { decodeFunctionData, encodeFunctionData, type Address } from "viem";

import { buildNativeToToken, buildTokenToNative, netOfFee, grossForNet } from "../src/nativeSwap.js";
import { refreshStaleDeadlines } from "../src/deadlines.js";
import { nfpmAbi, swapRouter02Abi } from "../src/abi.js";

const W = "0x39D7cD2964A7E7a32585017dca81f2ccf90F967A" as Address;
const WETH = "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73" as Address;
const USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as Address;
const SR02 = "0x101F443B4d1b059569D643917553c771E1b9663E" as Address;
const NFPM = "0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65" as Address;

const swapAmount = (data: `0x${string}`, key: "amountIn" | "amountOut") =>
  ((decodeFunctionData({ abi: swapRouter02Abi, data }).args as readonly [Record<string, bigint>])[0])[key];

describe("native swaps sized for the wallet's fee model", () => {
  it("V4: sizes around the fee taken from what arrives", () => {
    const toNative = buildTokenToNative({ router: SR02, wallet: W, weth: WETH, tokenIn: USDC, amountOut: 1_000_000n, amountInMaximum: 9n });
    expect(swapAmount(toNative[1].callData, "amountOut")).toBe(grossForNet(1_000_000n));
    const fromNative = buildNativeToToken({ router: SR02, wallet: W, weth: WETH, tokenOut: USDC, amountIn: 1_000_000n, amountOutMinimum: 1n });
    expect(swapAmount(fromNative[2].callData, "amountIn")).toBe(netOfFee(1_000_000n));
  });
  it("V5: exact amounts — the fee is charged on top, nothing is left over", () => {
    const toNative = buildTokenToNative({ router: SR02, wallet: W, weth: WETH, tokenIn: USDC, amountOut: 1_000_000n, amountInMaximum: 9n, feeOnTop: true });
    expect(swapAmount(toNative[1].callData, "amountOut")).toBe(1_000_000n);
    const fromNative = buildNativeToToken({ router: SR02, wallet: W, weth: WETH, tokenOut: USDC, amountIn: 1_000_000n, amountOutMinimum: 1n, feeOnTop: true });
    expect(swapAmount(fromNative[2].callData, "amountIn")).toBe(1_000_000n);
  });
});

describe("Uniswap v3 deadlines follow the chain's clock", () => {
  const mint = (deadline: bigint) => ({
    target: NFPM,
    value: 0n,
    callData: encodeFunctionData({
      abi: nfpmAbi,
      functionName: "mint",
      args: [{ token0: WETH, token1: USDC, fee: 500, tickLower: -10, tickUpper: 10, amount0Desired: 1n, amount1Desired: 1n, amount0Min: 0n, amount1Min: 0n, recipient: W, deadline }],
    }),
  });
  const deadlineOf = (data: `0x${string}`) =>
    ((decodeFunctionData({ abi: nfpmAbi, data }).args as readonly [{ deadline: bigint }])[0]).deadline;

  it("renews a deadline the chain already sees as past", () => {
    const [out] = refreshStaleDeadlines([mint(100n)], 10_000n, { nfpm: NFPM });
    expect(deadlineOf(out.callData)).toBe(10_000n + 1_200n);
  });
  it("keeps one that is still ahead", () => {
    const [out] = refreshStaleDeadlines([mint(20_000n)], 10_000n, { nfpm: NFPM });
    expect(deadlineOf(out.callData)).toBe(20_000n);
  });
});
