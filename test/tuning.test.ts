import { describe, expect, it } from "vitest";
import { encodeErrorResult, parseAbi, toFunctionSelector, type Hex } from "viem";

import { decodeSourceTag, encodeSourceTag, SOURCE_TAG_MAGIC } from "../src/sourceTag.js";
import { decodeRevert } from "../src/errors.js";
import { describeRange, priceToTick, pricesToTicks, tickToPrice } from "../src/lp/range.js";
import { withAgentFee } from "../src/v5.js";

const stringRevert = (msg: string): Hex =>
  encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: [msg] });

describe("source tag", () => {
  it("is 8 bytes: magic, tool, version", () => {
    const tag = encodeSourceTag({ tool: "mcp", version: "0.3.0" });
    expect(tag).toBe(`${SOURCE_TAG_MAGIC}02000300`);
    expect((tag.length - 2) / 2).toBe(8);
  });
  it("reads back from the end of a transaction's input", () => {
    const input = `0xdeadbeef${encodeSourceTag({ tool: "sdk", version: "1.2.3" }).slice(2)}` as Hex;
    expect(decodeSourceTag(input)).toEqual({ tool: "sdk", version: "1.2.3" });
    expect(decodeSourceTag("0xdeadbeef00000000000000000000")).toBeNull();
  });
  it("ignores pre-release suffixes and clamps parts", () => {
    expect(encodeSourceTag({ tool: "sdk", version: "0.0.0-dev" }).endsWith("01000000")).toBe(true);
    expect(encodeSourceTag({ tool: "sdk", version: "300.1.2" }).endsWith("01ff0102")).toBe(true);
  });
});

describe("retryable", () => {
  it("marks limits and permissions as not retryable", () => {
    for (const name of ["TokenTotalBudgetExceeded", "RecipientNotAllowed", "SelectorNotAllowed", "AgentCannotCallWallet"]) {
      expect(decodeRevert({ data: toFunctionSelector(`${name}()`) }).retryable).toBe(false);
    }
  });
  it("lets deadline and slippage failures be retried", () => {
    expect(decodeRevert({ data: toFunctionSelector("TransactionDeadlinePassed()") }).retryable).toBe(true);
    expect(decodeRevert({ data: toFunctionSelector("V3TooLittleReceived()") }).retryable).toBe(true);
  });
  it("explains Uniswap's STF as a missing balance, not retryable", () => {
    const d = decodeRevert({ data: stringRevert("STF") });
    expect(d.errorName).toBe("STF");
    expect(d.retryable).toBe(false);
    expect(d.humanMessage).toMatch(/does not hold enough/);
  });
  it("names Aave's numeric codes and its named errors", () => {
    expect(decodeRevert({ data: stringRevert("39") }).errorName).toBe("Aave:NO_DEBT_OF_SELECTED_TYPE");
    expect(decodeRevert({ data: toFunctionSelector("NoDebtOfSelectedType()") }).errorName).toBe("NoDebtOfSelectedType");
  });
});

describe("liquidity ranges", () => {
  // Arbitrum: WETH (18) sorts before USDC (6). tokenA = USDC, tokenB = WETH.
  it("puts 2,500 USDC per WETH near tick -198,000, not +78,000", () => {
    const t = priceToTick(2500, 6, 18, false);
    expect(t).toBeGreaterThan(-199_500);
    expect(t).toBeLessThan(-197_000);
    expect(tickToPrice(t, 6, 18, false)).toBeCloseTo(2500, -1);
  });
  it("orders the ticks whichever token sorts first", () => {
    const a = pricesToTicks(2000, 3000, 6, 18, true);
    const b = pricesToTicks(2000, 3000, 6, 18, false);
    expect(a.tickLower).toBeLessThan(a.tickUpper);
    expect(b.tickLower).toBeLessThan(b.tickUpper);
  });
  it("warns when the range does not contain the current price", () => {
    const current = priceToTick(2500, 6, 18, false);
    const r = describeRange({
      tickLower: 75_410,
      tickUpper: 79_460,
      currentTick: current,
      decimalsA: 6,
      decimalsB: 18,
      aIsToken0: false,
      symbolA: "USDC",
      symbolB: "WETH",
      fullRange: false,
    });
    expect(r.inRange).toBe(false);
    expect(r.warnings[0]).toMatch(/does not contain the current price/);
  });
  it("is quiet for a sensible range", () => {
    const { tickLower, tickUpper } = pricesToTicks(2000, 3000, 6, 18, false);
    const r = describeRange({
      tickLower,
      tickUpper,
      currentTick: priceToTick(2500, 6, 18, false),
      decimalsA: 6,
      decimalsB: 18,
      aIsToken0: false,
      symbolA: "USDC",
      symbolB: "WETH",
      fullRange: false,
    });
    expect(r.inRange).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});

describe("room for the V5 fee", () => {
  it("the largest movable amount plus its fee fits the balance", () => {
    for (const balance of [1n, 999n, 1_000_000n, 123_456_789_012_345_678n]) {
      let x = (balance * 1_000_000n) / 1_001_500n;
      while (withAgentFee(x + 1n) <= balance) x += 1n;
      while (x > 0n && withAgentFee(x) > balance) x -= 1n;
      expect(withAgentFee(x) <= balance).toBe(true);
      expect(withAgentFee(x + 1n) > balance).toBe(true);
    }
  });
});
