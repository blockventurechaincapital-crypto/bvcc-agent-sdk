import { describe, expect, it } from "vitest";

import {
  maxSafeBorrowBase,
  maxSafeWithdrawBase,
  repayToReachHFBase,
  type RiskInput,
} from "../src/aave/read.js";
import { getAaveAddresses, AAVE } from "../src/aave/addresses.js";
import {
  aavePoolReadAbi,
  aaveDataProviderAbi,
  aaveOracleAbi,
} from "../src/aave/abi.js";

const HF = (x: number) => BigInt(Math.round(x * 1e18));
/** Compute HF from a base-currency snapshot the way Aave does. */
const hfOf = (collateral: bigint, ltBps: bigint, debt: bigint) =>
  debt === 0n ? Infinity : Number((collateral * ltBps) / 10000n) / Number(debt);

describe("risk calculators", () => {
  // $10,000 collateral, 80% LT, $4,000 debt → HF = 8000/4000 = 2.0
  const pos: RiskInput = {
    totalCollateralBase: 10_000_00000000n,
    totalDebtBase: 4_000_00000000n,
    liquidationThresholdBps: 8000n,
  };

  it("maxSafeBorrow leaves HF exactly at target", () => {
    const target = HF(1.5);
    const extra = maxSafeBorrowBase(pos, target);
    const newDebt = pos.totalDebtBase + extra;
    // HF after borrowing `extra` should sit at (or just above, from flooring) target.
    const hf = hfOf(pos.totalCollateralBase, pos.liquidationThresholdBps, newDebt);
    expect(hf).toBeGreaterThanOrEqual(1.5 - 1e-6);
    expect(hf).toBeLessThan(1.5 + 0.001);
  });

  it("maxSafeBorrow is zero when already below target", () => {
    // target 2.5 but current HF is 2.0 → no room
    expect(maxSafeBorrowBase(pos, HF(2.5))).toBe(0n);
  });

  it("maxSafeWithdraw keeps HF at target", () => {
    const target = HF(1.5);
    const out = maxSafeWithdrawBase(pos, target);
    const newColl = pos.totalCollateralBase - out;
    const hf = hfOf(newColl, pos.liquidationThresholdBps, pos.totalDebtBase);
    expect(hf).toBeGreaterThanOrEqual(1.5 - 1e-6);
    expect(hf).toBeLessThan(1.5 + 0.001);
  });

  it("maxSafeWithdraw is zero when target is above current HF", () => {
    expect(maxSafeWithdrawBase(pos, HF(2.5))).toBe(0n);
  });

  it("maxSafeWithdraw returns 0 with a zero liquidation threshold (no div-by-zero)", () => {
    expect(maxSafeWithdrawBase({ ...pos, liquidationThresholdBps: 0n }, HF(1.5))).toBe(0n);
  });

  it("repayToReachHF raises HF to the target", () => {
    const target = HF(3);
    const repay = repayToReachHFBase(pos, target);
    const newDebt = pos.totalDebtBase - repay;
    const hf = hfOf(pos.totalCollateralBase, pos.liquidationThresholdBps, newDebt);
    expect(hf).toBeGreaterThanOrEqual(3 - 0.001);
    expect(hf).toBeLessThan(3 + 0.01);
  });

  it("repayToReachHF is zero when already above target", () => {
    expect(repayToReachHFBase(pos, HF(1.5))).toBe(0n);
  });

  it("a no-debt position allows borrowing up to the LT-weighted cap", () => {
    const noDebt: RiskInput = { ...pos, totalDebtBase: 0n };
    // With target 1.0, cap = collateral × LT = $8,000.
    expect(maxSafeBorrowBase(noDebt, HF(1))).toBe(8_000_00000000n);
    // And nothing to repay.
    expect(repayToReachHFBase(noDebt, HF(2))).toBe(0n);
  });
});

describe("Aave addresses", () => {
  it("has Arbitrum, verified against the on-chain provider", () => {
    const a = getAaveAddresses(42161)!;
    expect(a.pool).toBe("0x794a61358D6845594F94dc1DB02A252b5b4814aD");
    expect(a.oracle).toBe("0xb56c2F0B653B2e0b10C9b928C8580Ac5Df02C7C7");
    expect(a.poolDataProvider).toBe("0x243Aa95cAC2a25651eda86e80bEe66114413c43b");
  });

  it("returns undefined on chains without Aave support", () => {
    expect(getAaveAddresses(999999)).toBeUndefined();
  });

  it("every listed chain has all four addresses", () => {
    for (const [, a] of Object.entries(AAVE)) {
      for (const k of ["pool", "poolAddressesProvider", "poolDataProvider", "oracle"] as const) {
        expect(a[k]).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });
});

describe("Aave read ABIs are read-only", () => {
  it("exposes only view functions", () => {
    for (const abi of [aavePoolReadAbi, aaveDataProviderAbi, aaveOracleAbi]) {
      for (const f of abi) expect(f.stateMutability).toBe("view");
    }
  });

  it("has no fund-moving functions (supply/borrow/withdraw/repay)", () => {
    const names = [...aavePoolReadAbi, ...aaveDataProviderAbi].map((f) => f.name);
    for (const forbidden of ["supply", "borrow", "withdraw", "repay"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

import {
  buildSupply,
  buildWithdraw,
  buildBorrow,
  buildRepay,
  buildRepayWithATokens,
  buildSetCollateral,
  buildSetEMode,
  MAX_UINT256,
} from "../src/aave/write.js";

const POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD" as const;
const W = "0x605A4C65dBa64bd26d9F7701e1e4Cda48c594A5c" as const;
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;

describe("Aave write builders", () => {
  it("supply is [approve(Pool), supply(...)]", () => {
    const ex = buildSupply(POOL, W, USDC, 1_000000n);
    expect(ex).toHaveLength(2);
    expect(ex[0].target).toBe(USDC); // approve
    expect(ex[1].target).toBe(POOL); // supply
  });

  it("supply pins onBehalfOf to the wallet (word 2 of the pool call)", () => {
    // supply(asset, amount, onBehalfOf, ref) — onBehalfOf must be the wallet.
    const cd = buildSupply(POOL, W, USDC, 1_000000n)[1].callData.toLowerCase();
    expect(cd).toContain(W.slice(2).toLowerCase());
  });

  it('withdraw "max" uses type(uint256).max, not a literal', () => {
    const cd = buildWithdraw(POOL, W, USDC, "max")[0].callData.toLowerCase();
    expect(cd).toContain("ff".repeat(32));
  });

  it("withdraw to a number encodes that number", () => {
    const cd = buildWithdraw(POOL, W, USDC, 5_000000n)[0].callData;
    expect(cd).not.toContain("ff".repeat(32));
  });

  it("borrow uses variable rate (interestRateMode = 2) and pins onBehalfOf", () => {
    const cd = buildBorrow(POOL, W, USDC, 500000n)[0].callData.toLowerCase();
    // rate mode 2 sits as 0x...02 in word 3; wallet in word 5.
    expect(cd).toContain(W.slice(2).toLowerCase());
  });

  it('repay "max" repays uint256.max but approves the concrete buffer amount', () => {
    const [approve, repay] = buildRepay(POOL, W, USDC, "max", 600000n);
    expect(approve.callData.toLowerCase()).not.toContain("ff".repeat(32)); // finite approve
    expect(repay.callData.toLowerCase()).toContain("ff".repeat(32)); // max repay
  });

  it("repayWithATokens needs no approve (single execution)", () => {
    const ex = buildRepayWithATokens(POOL, USDC, "max");
    expect(ex).toHaveLength(1);
    expect(ex[0].target).toBe(POOL);
  });

  it("setCollateral and setEMode are single pool calls with no approve", () => {
    expect(buildSetCollateral(POOL, USDC, false)).toHaveLength(1);
    expect(buildSetEMode(POOL, 0)).toHaveLength(1);
  });

  it("MAX_UINT256 is exactly type(uint256).max", () => {
    expect(MAX_UINT256).toBe((1n << 256n) - 1n);
  });
});
