import { describe, expect, it } from "vitest";

import {
  assertBudget,
  assertChunkAboveMinimum,
  assertIterationsLeft,
  assertPositionWorkable,
  assertPriceImpact,
  assertProgress,
  assertReserveUsable,
  CONTROL_DEFAULTS,
  PlannerError,
  repayAmountForChunk,
  resolveControls,
  swappableAfterWithdraw,
  type AbortReason,
} from "../src/aave/planner.js";
import { projectHealthFactor, type AaveReserveInfo, type RiskInput } from "../src/aave/read.js";

const wad = (x: number) => BigInt(Math.round(x * 1e18));
const usd = (x: number) => BigInt(Math.round(x * 1e8)); // oracle base currency
const fmt = (v: bigint) => `$${(Number(v) / 1e8).toFixed(2)}`;

/** Assert a call aborts with a specific machine-readable reason. */
function expectAbort(fn: () => void, reason: AbortReason) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PlannerError);
    expect((e as PlannerError).abort.reason).toBe(reason);
    // Every abort must tell the agent something, not just say no.
    expect((e as PlannerError).abort.message.length).toBeGreaterThan(10);
    return e as PlannerError;
  }
  throw new Error(`expected an abort with reason "${reason}", but the call succeeded`);
}

const reserve = (over: Partial<AaveReserveInfo> = {}): AaveReserveInfo => ({
  asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  symbol: "USDC",
  decimals: 6,
  supplyApy: "2.78",
  variableBorrowApy: "3.75",
  ltvBps: 7500,
  liquidationThresholdBps: 7800,
  liquidationBonusBps: 10500,
  isActive: true,
  isFrozen: false,
  borrowingEnabled: true,
  usageAsCollateralEnabled: true,
  priceUsd: "1.00",
  aTokenAddress: "0x724dc807b04555b71ed48a6896b6F41593b8C637",
  variableDebtTokenAddress: "0xf611aEb5013fD2c0511c9CD55c7dc5C1140741A6",
  isPaused: false,
  supplyCap: 0n,
  borrowCap: 0n,
  debtCeiling: 0n,
  siloedBorrowing: false,
  totalSupplied: 0n,
  totalVariableDebt: 0n,
  ...over,
});

describe("controls resolution", () => {
  it("requires slippage protection — every chunk contains a swap", () => {
    expect(() => resolveControls({ slippageBps: 0 })).toThrow(/slippageBps/i);
    expect(() => resolveControls({ slippageBps: -1 })).toThrow(/slippageBps/i);
  });

  it("applies conservative defaults", () => {
    const c = resolveControls({ slippageBps: 50 });
    expect(c.hfFloor).toBe(CONTROL_DEFAULTS.hfFloor);
    expect(c.maximumIterations).toBe(10);
    expect(c.maxPriceImpactBps).toBe(200);
  });
});

describe("control 1 — position too tight", () => {
  // $1,000 collateral, 80% LT, $700 debt → HF = 800/700 = 1.14
  const healthy: RiskInput = {
    totalCollateralBase: usd(1000),
    totalDebtBase: usd(700),
    liquidationThresholdBps: 8000n,
  };

  it("allows a position with room above the floor", () => {
    expect(() => assertPositionWorkable(healthy, wad(1.05), fmt)).not.toThrow();
  });

  it("is a no-op when there is no debt at all", () => {
    expect(() => assertPositionWorkable({ ...healthy, totalDebtBase: 0n }, wad(1.05), fmt)).not.toThrow();
  });

  it("aborts when the floor leaves no withdrawable collateral", () => {
    // HF 1.14 but asking for a 1.5 floor → no room to withdraw anything.
    const e = expectAbort(() => assertPositionWorkable(healthy, wad(1.5), fmt), "position-too-tight");
    // The whole point: it must say how much to repay to unblock, not just "infeasible".
    expect(e.abort.suggestedAction).toMatch(/repay/i);
    expect(e.abort.suggestedAction).toMatch(/\$\d/);
    expect(e.abort.recoverable).toBe(true);
  });

  it("reports the current health factor in the message", () => {
    const e = expectAbort(() => assertPositionWorkable(healthy, wad(1.5), fmt), "position-too-tight");
    expect(e.abort.message).toMatch(/1\.14/);
  });
});

describe("control 2/3 — chunk size and iterations", () => {
  it("aborts on a dust-sized chunk", () => {
    expectAbort(() => assertChunkAboveMinimum(5n, 100n, (v) => `${v}`), "chunk-below-minimum");
  });

  it("allows any chunk when no minimum is set", () => {
    expect(() => assertChunkAboveMinimum(1n, 0n, (v) => `${v}`)).not.toThrow();
  });

  it("aborts once the iteration bound is reached", () => {
    expect(() => assertIterationsLeft(9, 10, "$5")).not.toThrow();
    expectAbort(() => assertIterationsLeft(10, 10, "$5"), "max-iterations");
  });
});

describe("control 4 — strict progress (loop termination)", () => {
  it("accepts a strict decrease", () => {
    expect(() => assertProgress(usd(500), usd(400), fmt)).not.toThrow();
  });

  it("aborts when the pending amount grew — interest outpacing the chunk", () => {
    const e = expectAbort(() => assertProgress(usd(500), usd(501), fmt), "no-progress");
    expect(e.abort.recoverable).toBe(false);
  });

  it("aborts when it merely stalled, not only when it grew", () => {
    expectAbort(() => assertProgress(usd(500), usd(500), fmt), "no-progress");
  });
});

describe("control 5 — price impact vs the Aave oracle", () => {
  const base = {
    amountIn: 1_000000n, // 1 USDC (6 dp)
    priceInBase: usd(1), // $1
    priceOutBase: usd(2000), // $2000
    decimalsIn: 6,
    decimalsOut: 18,
    maxBps: 200,
  };
  // Oracle-fair output for 1 USDC at $2000/ETH = 0.0005 ETH.
  const fair = 5n * 10n ** 14n;

  it("accepts a quote at the oracle price", () => {
    expect(() => assertPriceImpact({ ...base, quotedOut: fair })).not.toThrow();
  });

  it("accepts a quote BETTER than the oracle", () => {
    expect(() => assertPriceImpact({ ...base, quotedOut: (fair * 11n) / 10n })).not.toThrow();
  });

  it("accepts a shortfall inside the limit", () => {
    expect(() => assertPriceImpact({ ...base, quotedOut: (fair * 9900n) / 10000n })).not.toThrow(); // -1%
  });

  it("aborts on a shortfall beyond the limit", () => {
    const e = expectAbort(
      () => assertPriceImpact({ ...base, quotedOut: (fair * 9000n) / 10000n }), // -10%
      "price-impact",
    );
    expect(e.abort.message).toMatch(/bps/);
  });

  it("aborts when there is no quote at all", () => {
    expectAbort(() => assertPriceImpact({ ...base, quotedOut: 0n }), "no-quote");
  });
});

describe("control 6 — reserve state", () => {
  it("accepts a normal reserve", () => {
    expect(() => assertReserveUsable({ reserve: reserve(), leg: "withdraw", amount: 1n })).not.toThrow();
  });

  it("rejects a paused reserve for any leg", () => {
    const e = expectAbort(
      () => assertReserveUsable({ reserve: reserve({ isPaused: true }), leg: "repay", amount: 1n }),
      "reserve-unavailable",
    );
    expect(e.abort.recoverable).toBe(false);
  });

  it("lets a FROZEN reserve still be repaid and withdrawn", () => {
    // Freezing blocks new exposure only — deleveraging must keep working.
    const frozen = reserve({ isFrozen: true });
    expect(() => assertReserveUsable({ reserve: frozen, leg: "withdraw", amount: 1n })).not.toThrow();
    expect(() => assertReserveUsable({ reserve: frozen, leg: "repay", amount: 1n })).not.toThrow();
    expectAbort(() => assertReserveUsable({ reserve: frozen, leg: "supply", amount: 1n }), "reserve-unavailable");
  });

  it("respects the supply cap", () => {
    const r = reserve({ supplyCap: 100n, totalSupplied: 99_000000n }); // 99 of 100 used
    expect(() => assertReserveUsable({ reserve: r, leg: "supply", amount: 1_000000n })).not.toThrow();
    expectAbort(() => assertReserveUsable({ reserve: r, leg: "supply", amount: 2_000000n }), "cap-exceeded");
  });

  it("respects the borrow cap", () => {
    const r = reserve({ borrowCap: 100n, totalVariableDebt: 99_500000n });
    expectAbort(() => assertReserveUsable({ reserve: r, leg: "borrow", amount: 1_000000n }), "cap-exceeded");
  });

  it("refuses to borrow a siloed asset alongside other debt", () => {
    expectAbort(
      () => assertReserveUsable({ reserve: reserve({ siloedBorrowing: true }), leg: "borrow", amount: 1n }),
      "siloed-borrowing",
    );
  });

  it("refuses to supply an isolated asset as collateral", () => {
    expectAbort(
      () => assertReserveUsable({ reserve: reserve({ debtCeiling: 1_000_000n }), leg: "supply", amount: 1n }),
      "isolation-mode",
    );
  });

  it("refuses to borrow where borrowing is disabled", () => {
    expectAbort(
      () => assertReserveUsable({ reserve: reserve({ borrowingEnabled: false }), leg: "borrow", amount: 1n }),
      "reserve-unavailable",
    );
  });
});

describe("control 7 — agent budget across the whole plan", () => {
  it("passes when the limit is unlimited", () => {
    expect(() =>
      assertBudget({ token: "0x0", symbol: "USDC", required: 10n ** 18n, remaining: null, fmt }),
    ).not.toThrow();
  });

  it("passes when the budget covers the plan", () => {
    expect(() =>
      assertBudget({ token: "0x0", symbol: "USDC", required: usd(10), remaining: usd(20), fmt }),
    ).not.toThrow();
  });

  it("aborts BEFORE chunk 1 when the total would run out", () => {
    const e = expectAbort(
      () => assertBudget({ token: "0x0", symbol: "USDC", required: usd(30), remaining: usd(20), fmt }),
      "insufficient-budget",
    );
    // Must state the shortfall, so the owner knows exactly how much to raise.
    expect(e.abort.suggestedAction).toMatch(/\$10\.00/);
  });
});

describe("chunk arithmetic (two fees per chunk)", () => {
  it("encodes the repay from the guaranteed floor, not the quote", () => {
    const quoteFloor = 1_000_000n;
    const repay = repayAmountForChunk(quoteFloor);
    expect(repay).toBe(998_500n); // floor minus the 0.15% taken on the swap output
    expect(repay).toBeLessThan(quoteFloor);
  });

  it("accounts for the withdrawal's own fee before swapping", () => {
    expect(swappableAfterWithdraw(1_000_000n)).toBe(998_500n);
  });

  it("never encodes more than the wallet can hold after both fees", () => {
    // The chunk withdraws C, so it can swap netOfFee(C); the swap floor is Q, and
    // the wallet ends up with netOfFee(Q). Encoding netOfFee(Q) must be safe.
    for (const c of [1_000000n, 12_345_678n, 10n ** 18n]) {
      const swappable = swappableAfterWithdraw(c);
      const worstCaseOut = swappable / 2n; // pessimistic quote floor
      expect(repayAmountForChunk(worstCaseOut)).toBeLessThanOrEqual(worstCaseOut);
    }
  });
});

describe("projectHealthFactor (chunk sizing)", () => {
  const pos: RiskInput = {
    totalCollateralBase: usd(1000),
    totalDebtBase: usd(500),
    liquidationThresholdBps: 8000n,
  };

  it("matches the plain formula with no deltas", () => {
    // 1000 × 0.8 / 500 = 1.6
    expect(Number(projectHealthFactor(pos)) / 1e18).toBeCloseTo(1.6, 6);
  });

  it("shows a deleverage chunk IMPROVING health", () => {
    // Withdraw $100 collateral, repay $100 debt → 900×0.8/400 = 1.8
    const after = projectHealthFactor(pos, { collateralBase: -usd(100), debtBase: -usd(100) });
    expect(Number(after) / 1e18).toBeCloseTo(1.8, 6);
    expect(after).toBeGreaterThan(projectHealthFactor(pos));
  });

  it("shows withdrawing WITHOUT repaying hurting health", () => {
    const after = projectHealthFactor(pos, { collateralBase: -usd(100) });
    expect(after).toBeLessThan(projectHealthFactor(pos));
  });

  it("reports infinity once the debt is gone", () => {
    expect(projectHealthFactor(pos, { debtBase: -usd(500) })).toBe((1n << 256n) - 1n);
  });
});

import {
  assertIntermediateHealth,
  assertSiloedCompatible,
  assertUsableAsCollateral,
} from "../src/aave/planner.js";
import { healthFactorFromWeighted, weightedCollateralBase } from "../src/aave/read.js";

describe("control 8 — the dangerous instant inside a swap chunk", () => {
  it("allows a dip that stays above the floor", () => {
    expect(() =>
      assertIntermediateHealth({ intermediateHf: wad(1.2), hfFloorWad: wad(1.05), operation: "collateral-swap" }),
    ).not.toThrow();
  });

  it("aborts a collateral swap that dips below while the new collateral is missing", () => {
    const e = expectAbort(
      () => assertIntermediateHealth({ intermediateHf: wad(0.98), hfFloorWad: wad(1.05), operation: "collateral-swap" }),
      "position-too-tight",
    );
    // The message must name WHICH instant, or the agent cannot reason about it.
    expect(e.abort.message).toMatch(/before the new one is supplied/i);
  });

  it("aborts a debt swap that dips below while both debts are outstanding", () => {
    const e = expectAbort(
      () => assertIntermediateHealth({ intermediateHf: wad(1.0), hfFloorWad: wad(1.05), operation: "debt-swap" }),
      "position-too-tight",
    );
    expect(e.abort.message).toMatch(/before the old one is repaid/i);
  });
});

describe("collateral swap — destination must actually back the position", () => {
  it("accepts a reserve usable as collateral", () => {
    expect(() => assertUsableAsCollateral(reserve())).not.toThrow();
  });

  it("refuses swapping into an asset Aave will not count as collateral", () => {
    const e = expectAbort(
      () => assertUsableAsCollateral(reserve({ usageAsCollateralEnabled: false })),
      "reserve-unavailable",
    );
    expect(e.abort.message).toMatch(/collateral/i);
    expect(e.abort.recoverable).toBe(false);
  });
});

describe("debt swap — siloed assets in both directions", () => {
  it("accepts two ordinary assets", () => {
    expect(() => assertSiloedCompatible(reserve(), reserve())).not.toThrow();
  });

  it("refuses borrowing INTO a siloed asset while another debt is open", () => {
    const e = expectAbort(
      () => assertSiloedCompatible(reserve({ symbol: "USDC" }), reserve({ symbol: "SILO", siloedBorrowing: true })),
      "siloed-borrowing",
    );
    expect(e.abort.message).toMatch(/only debt/i);
  });

  it("refuses opening a second debt alongside an existing siloed one", () => {
    expectAbort(
      () => assertSiloedCompatible(reserve({ symbol: "SILO", siloedBorrowing: true }), reserve({ symbol: "USDC" })),
      "siloed-borrowing",
    );
  });
});

describe("weighted-collateral health (collateral swaps change the blend)", () => {
  const pos: RiskInput = {
    totalCollateralBase: usd(1000),
    totalDebtBase: usd(500),
    liquidationThresholdBps: 8000n,
  };

  it("reproduces the plain health factor when nothing moves", () => {
    expect(Number(healthFactorFromWeighted(weightedCollateralBase(pos), pos.totalDebtBase)) / 1e18).toBeCloseTo(1.6, 6);
  });

  it("shows swapping into a WEAKER asset lowering health at equal value", () => {
    // Move $500 from an 80% asset into a 60% one, same dollar value.
    const w = weightedCollateralBase(pos) - (usd(500) * 8000n) / 10000n + (usd(500) * 6000n) / 10000n;
    const after = healthFactorFromWeighted(w, pos.totalDebtBase);
    expect(after).toBeLessThan(healthFactorFromWeighted(weightedCollateralBase(pos), pos.totalDebtBase));
    expect(Number(after) / 1e18).toBeCloseTo(1.4, 6); // (400+300)/500
  });

  it("shows swapping into a STRONGER asset raising health", () => {
    const w = weightedCollateralBase(pos) - (usd(500) * 8000n) / 10000n + (usd(500) * 9000n) / 10000n;
    expect(healthFactorFromWeighted(w, pos.totalDebtBase)).toBeGreaterThan(
      healthFactorFromWeighted(weightedCollateralBase(pos), pos.totalDebtBase),
    );
  });

  it("reports infinity with no debt", () => {
    expect(healthFactorFromWeighted(usd(100), 0n)).toBe((1n << 256n) - 1n);
  });
});
