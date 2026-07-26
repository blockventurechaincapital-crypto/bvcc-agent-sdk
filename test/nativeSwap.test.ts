import { describe, expect, it } from "vitest";
import { encodeFunctionData, toFunctionSelector } from "viem";

import {
  BVCC_FEE_BPS,
  buildNativeToToken,
  buildTokenToNative,
  grossForNet,
  netOfFee,
} from "../src/nativeSwap.js";
import { swapRouter02Abi } from "../src/abi.js";

const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as const;
const WALLET = "0x605A4C65dBa64bd26d9F7701e1e4Cda48c594A5c" as const;
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as const;
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;

/** Which 32-byte word (0-indexed, after the selector) holds `addr`. */
function wordOf(calldata: string, addr: string): number[] {
  const body = calldata.slice(10);
  const target = addr.slice(2).toLowerCase().padStart(64, "0");
  const out: number[] = [];
  for (let i = 0; i * 64 < body.length; i++) {
    if (body.slice(i * 64, (i + 1) * 64).toLowerCase() === target) out.push(i);
  }
  return out;
}

describe("fee maths", () => {
  it("netOfFee removes exactly 0.15%", () => {
    expect(netOfFee(1_000_000n)).toBe(998_500n);
    expect(BVCC_FEE_BPS).toBe(15n);
  });

  it("grossForNet is the inverse — the wallet is never left short", () => {
    for (const net of [1n, 12_345n, 1_000_000n, 10n ** 18n]) {
      // Rounding must land at or above the target, never below.
      expect(netOfFee(grossForNet(net))).toBeGreaterThanOrEqual(net);
    }
  });
});

describe("token → ETH batch", () => {
  const ex = buildTokenToNative({
    router: ROUTER,
    wallet: WALLET,
    weth: WETH,
    tokenIn: USDC,
    amountOut: 10n ** 15n, // 0.001 ETH
    amountInMaximum: 5_000_000n,
    fee: 500,
  });

  it("is [approve, exactOutputSingle, WETH.withdraw]", () => {
    expect(ex).toHaveLength(3);
    expect(ex[0].target).toBe(USDC);
    expect(ex[1].target).toBe(ROUTER);
    expect(ex[2].target).toBe(WETH);
  });

  it("uses exactOutputSingle so no WETH dust is stranded", () => {
    expect(ex[1].callData.slice(0, 10)).toBe(toFunctionSelector("exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))"));
  });

  it("sends the swap output to the wallet, at the pinnable word 3", () => {
    expect(wordOf(ex[1].callData, WALLET)).toContain(3);
  });

  it("asks the pool for more than the target so the fee still leaves the exact amount", () => {
    const target = 10n ** 15n;
    // amountOut is word 4 of exactOutputSingle.
    const gross = BigInt("0x" + ex[1].callData.slice(10).slice(4 * 64, 5 * 64));
    expect(gross).toBeGreaterThan(target);
    expect(netOfFee(gross)).toBeGreaterThanOrEqual(target);
  });

  it("never routes through ADDRESS_THIS (what the V3 validator denies)", () => {
    for (const e of ex) {
      expect(e.callData.toLowerCase()).not.toContain("0".repeat(39) + "2");
    }
  });

  it("sends no ETH value — the wallet only receives it", () => {
    for (const e of ex) expect(e.value).toBe(0n);
  });
});

describe("ETH → token batch", () => {
  const amountIn = 10n ** 16n; // 0.01 ETH
  const ex = buildNativeToToken({
    router: ROUTER,
    wallet: WALLET,
    weth: WETH,
    tokenOut: USDC,
    amountIn,
    amountOutMinimum: 1n,
    fee: 500,
  });

  it("is [WETH.deposit{value}, approve, exactInputSingle]", () => {
    expect(ex).toHaveLength(3);
    expect(ex[0].target).toBe(WETH);
    expect(ex[0].value).toBe(amountIn); // the only leg carrying ETH
    expect(ex[1].target).toBe(WETH); // approve WETH to the router
    expect(ex[2].target).toBe(ROUTER);
  });

  it("swaps the POST-fee WETH, not the ETH sent — otherwise the batch reverts", () => {
    // amountIn is word 4 of exactInputSingle.
    const swapped = BigInt("0x" + ex[2].callData.slice(10).slice(4 * 64, 5 * 64));
    expect(swapped).toBe(netOfFee(amountIn));
    expect(swapped).toBeLessThan(amountIn);
  });

  it("sends the swap output to the wallet", () => {
    expect(wordOf(ex[2].callData, WALLET)).toContain(3);
  });
});

describe("SwapRouter02 recipient words (pin positions)", () => {
  const PATH = "0xaf88d065e77c8cc2239327c5edb3a432268e58310001f482af49447d8a07e3bd95bd0d56f35241523fbab1" as const;

  it("static structs put the recipient at word 3", () => {
    const single = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [{ tokenIn: USDC, tokenOut: WETH, fee: 500, recipient: WALLET, amountIn: 1n, amountOutMinimum: 2n, sqrtPriceLimitX96: 0n }],
    });
    const out = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactOutputSingle",
      args: [{ tokenIn: USDC, tokenOut: WETH, fee: 500, recipient: WALLET, amountOut: 1n, amountInMaximum: 2n, sqrtPriceLimitX96: 0n }],
    });
    expect(wordOf(single, WALLET)).toEqual([3]);
    expect(wordOf(out, WALLET)).toEqual([3]);
  });

  it("multi-hop structs are dynamic, so the recipient moves to word 2", () => {
    // Regression guard: the frontend pins word 2 for these. If a viem/ABI change
    // ever shifted it, pinning would silently guard the wrong argument.
    const mIn = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactInput",
      args: [{ path: PATH, recipient: WALLET, amountIn: 1n, amountOutMinimum: 2n }],
    });
    const mOut = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactOutput",
      args: [{ path: PATH, recipient: WALLET, amountOut: 1n, amountInMaximum: 2n }],
    });
    expect(wordOf(mIn, WALLET)).toEqual([2]);
    expect(wordOf(mOut, WALLET)).toEqual([2]);
  });

  it("selectors match the ones deployed on Arbitrum's SwapRouter02", () => {
    // Confirmed present in the deployed bytecode on 21 Jul 2026.
    expect(toFunctionSelector("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))")).toBe("0x04e45aaf");
    expect(toFunctionSelector("exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))")).toBe("0x5023b4df");
    expect(toFunctionSelector("exactInput((bytes,address,uint256,uint256))")).toBe("0xb858183f");
    expect(toFunctionSelector("exactOutput((bytes,address,uint256,uint256))")).toBe("0x09b81346");
  });
});
