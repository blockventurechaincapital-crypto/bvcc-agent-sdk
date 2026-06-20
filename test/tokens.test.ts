import { describe, expect, it } from "vitest";
import { resolveToken } from "../src/tokens.js";

describe("resolveToken", () => {
  it("resolves a known symbol with correct decimals", () => {
    const t = resolveToken(42161, "USDC");
    expect(t.address.toLowerCase()).toBe("0xaf88d065e77c8cc2239327c5edb3a432268e5831");
    expect(t.decimals).toBe(6);
    expect(t.symbol).toBe("USDC");
  });

  it("uses 18 decimals for Binance-Peg stables on BNB Chain", () => {
    expect(resolveToken(56, "USDC").decimals).toBe(18);
    expect(resolveToken(56, "USDT").decimals).toBe(18);
  });

  it("is case-insensitive for symbols", () => {
    expect(resolveToken(1, "usdc").address).toBe(resolveToken(1, "USDC").address);
  });

  it("passes through a known address with metadata", () => {
    const t = resolveToken(42161, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
    expect(t.symbol).toBe("USDC");
    expect(t.decimals).toBe(6);
  });

  it("passes through an unknown address with null metadata", () => {
    const addr = "0x1111111111111111111111111111111111111111";
    const t = resolveToken(42161, addr);
    expect(t.address).toBe(addr);
    expect(t.symbol).toBeNull();
    expect(t.decimals).toBeNull();
  });

  it("throws on an unknown symbol", () => {
    expect(() => resolveToken(42161, "NOPE")).toThrow(/Unknown token symbol/);
  });
});
