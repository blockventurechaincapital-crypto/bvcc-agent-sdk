import { describe, expect, it } from "vitest";
import { applySlippage } from "../src/quote.js";
import { encodeV3Path } from "../src/universalRouter.js";
import { buildV4SwapExactIn } from "../src/universalRouterV4.js";

describe("applySlippage", () => {
  it("reduces by the given bps", () => {
    expect(applySlippage(1_000_000n, 50)).toBe(995_000n); // 0.5%
    expect(applySlippage(1_000_000n, 0)).toBe(1_000_000n);
    expect(applySlippage(1_000_000n, 10_000)).toBe(0n); // 100%
  });

  it("clamps out-of-range bps", () => {
    expect(applySlippage(1_000_000n, -5)).toBe(1_000_000n);
    expect(applySlippage(1_000_000n, 20_000)).toBe(0n);
  });
});

describe("encodeV3Path", () => {
  it("packs token, fee, token", () => {
    const usdc = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    const weth = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
    const path = encodeV3Path([usdc, weth], [500]);
    // 20 + 3 + 20 = 43 bytes => 86 hex chars + 0x
    expect(path.length).toBe(2 + 86);
    expect(path.toLowerCase()).toContain("0001f4"); // fee 500
  });
});

describe("buildV4SwapExactIn (pure structure)", () => {
  it("produces a 3-item Permit2-funded batch ending at the router", () => {
    const usdc = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    const weth = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
    const router = "0x8b844f885672f333bc0042cb669255f93a4c1e6b";
    const batch = buildV4SwapExactIn({
      router,
      tokenIn: usdc,
      tokenOut: weth,
      amountIn: 100_000n,
      amountOutMinimum: 1n,
      fee: 500,
      tickSpacing: 10,
    });
    expect(batch.length).toBe(3);
    expect(batch[2].target.toLowerCase()).toBe(router);
    // first item is the ERC-20 approve to Permit2
    expect(batch[0].target.toLowerCase()).toBe(usdc.toLowerCase());
  });
});
