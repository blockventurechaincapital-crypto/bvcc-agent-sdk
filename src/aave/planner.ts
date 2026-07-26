/**
 * Aave planner engine — chunked deleveraging without flash loans.
 *
 * The problem it solves: collateral backs debt, so you cannot withdraw while you
 * owe, and you cannot repay because your money is locked as collateral. The way
 * out is to work in chunks — withdraw only what safety allows, swap it to the debt
 * asset, repay, which frees more collateral, repeat.
 *
 * Two properties make this safe enough to run unattended:
 *
 *  1. **Each chunk is one atomic batch.** If any leg fails, the whole transaction
 *     reverts and the position is untouched. There is no observable half-state.
 *  2. **Nothing is sent speculatively.** Every control is evaluated before each
 *     chunk; a violation aborts with a structured reason instead of "let's try it
 *     and see".
 *
 * The hard constraint shaping everything: inside one transaction you cannot read
 * the swap's real output, so the final leg is encoded with the GUARANTEED minimum
 * (quote floor, minus the BVCC fee). Whatever the swap actually returned above
 * that stays in the wallet and the next chunk absorbs it.
 */
import type { Address } from "viem";

import { netOfFee } from "../nativeSwap.js";
import {
  maxSafeWithdrawBase,
  projectHealthFactor,
  repayToReachHFBase,
  type AaveReserveInfo,
  type RiskInput,
} from "./read.js";

/** Knobs shared by every planner. Defaults are conservative on purpose. */
export interface AavePlannerControls {
  /** Minimum health factor after each chunk. Default "1.05". */
  hfFloor?: string;
  /** Required: protects each swap leg. */
  slippageBps: number;
  /** In units of the asset being withdrawn; a safe chunk below this aborts. */
  minimumChunkAmount?: string;
  /** Hard bound on chunks. Default 10. */
  maximumIterations?: number;
  /** Effective swap price vs AaveOracle. Default 200 (2%). */
  maxPriceImpactBps?: number;
  /** Leftover accepted at the end without a sweep leg. Default 50 (0.5%). */
  dustToleranceBps?: number;
}

export type ResolvedControls = Required<AavePlannerControls>;

export const CONTROL_DEFAULTS = {
  hfFloor: "1.05",
  minimumChunkAmount: "0",
  maximumIterations: 10,
  maxPriceImpactBps: 200,
  dustToleranceBps: 50,
} as const;

export function resolveControls(c: AavePlannerControls): ResolvedControls {
  if (!Number.isFinite(c.slippageBps) || c.slippageBps <= 0) {
    throw new Error("slippageBps is required and must be > 0 — every swap leg needs price protection.");
  }
  return {
    hfFloor: c.hfFloor ?? CONTROL_DEFAULTS.hfFloor,
    slippageBps: c.slippageBps,
    minimumChunkAmount: c.minimumChunkAmount ?? CONTROL_DEFAULTS.minimumChunkAmount,
    maximumIterations: c.maximumIterations ?? CONTROL_DEFAULTS.maximumIterations,
    maxPriceImpactBps: c.maxPriceImpactBps ?? CONTROL_DEFAULTS.maxPriceImpactBps,
    dustToleranceBps: c.dustToleranceBps ?? CONTROL_DEFAULTS.dustToleranceBps,
  };
}

/** Why a plan or a chunk was refused. Machine-readable so an agent can react. */
export type AbortReason =
  | "position-too-tight"
  | "chunk-below-minimum"
  | "max-iterations"
  | "no-progress"
  | "no-quote"
  | "price-impact"
  | "reserve-unavailable"
  | "cap-exceeded"
  | "isolation-mode"
  | "siloed-borrowing"
  | "insufficient-budget";

export interface PlannerAbort {
  reason: AbortReason;
  message: string;
  /** What the caller could do about it. Empty when nothing can be done. */
  suggestedAction: string;
  /** True when adding funds or changing controls could make it work. */
  recoverable: boolean;
}

export class PlannerError extends Error {
  constructor(readonly abort: PlannerAbort) {
    super(abort.message);
    this.name = "PlannerError";
  }
}

const fail = (
  reason: AbortReason,
  message: string,
  suggestedAction = "",
  recoverable = true,
): never => {
  throw new PlannerError({ reason, message, suggestedAction, recoverable });
};

// ── Control 1 — is the position even workable? ───────────────────────────────

/**
 * Refuse a position too tight to chunk, with the numbers needed to unblock it.
 *
 * When the health factor sits at or below the floor, `maxSafeWithdraw` is 0: no
 * collateral can leave without crossing the floor, so chunking cannot start at
 * all. This is exactly the emergency case, and a flash loan would be the only way
 * through (out of scope). Rather than "infeasible", the caller gets the amount of
 * debt that would have to be repaid from wallet balance to open room — which is
 * something an agent can actually act on.
 */
export function assertPositionWorkable(
  pos: RiskInput,
  hfFloorWad: bigint,
  fmt: (base: bigint) => string,
): void {
  if (pos.totalDebtBase === 0n) return; // nothing to deleverage
  const room = maxSafeWithdrawBase(pos, hfFloorWad);
  if (room > 0n) return;

  const currentHf = projectHealthFactor(pos);
  const needed = repayToReachHFBase(pos, hfFloorWad);
  fail(
    "position-too-tight",
    `The position is too tight to deleverage in chunks: at a floor of ${
      Number(hfFloorWad) / 1e18
    } no collateral can be withdrawn (current health factor ${(Number(currentHf) / 1e18).toFixed(3)}).`,
    needed > 0n
      ? `Repay about ${fmt(needed)} of debt from the wallet's own balance first to open room, then retry. ` +
          `Alternatively lower hfFloor, accepting less safety margin.`
      : "Lower hfFloor or add collateral.",
  );
}

// ── Control 2/3 — chunk size and iteration bound ─────────────────────────────

export function assertChunkAboveMinimum(chunk: bigint, minimum: bigint, fmtAsset: (v: bigint) => string): void {
  if (minimum > 0n && chunk < minimum) {
    fail(
      "chunk-below-minimum",
      `The largest safe chunk (${fmtAsset(chunk)}) is below minimumChunkAmount (${fmtAsset(minimum)}).`,
      "Lower minimumChunkAmount, or lower hfFloor so bigger chunks are allowed. Tiny chunks only burn gas and fees.",
    );
  }
}

export function assertIterationsLeft(done: number, max: number, pendingLabel: string): void {
  if (done >= max) {
    fail(
      "max-iterations",
      `Reached maximumIterations (${max}) with ${pendingLabel} still outstanding.`,
      "Raise maximumIterations, or lower hfFloor so each chunk moves more.",
    );
  }
}

// ── Control 4 — strict progress ──────────────────────────────────────────────

/**
 * Abort when a chunk failed to reduce what is pending.
 *
 * Interest keeps accruing between chunks, so a chunk that repays too little can be
 * fully eaten by it — the loop would spin forever, paying gas and fees for nothing.
 * Requiring a strict decrease is what makes the loop provably terminate.
 */
export function assertProgress(previous: bigint, current: bigint, fmt: (v: bigint) => string): void {
  if (current >= previous) {
    fail(
      "no-progress",
      `The last chunk did not reduce the outstanding amount (${fmt(previous)} → ${fmt(current)}); accrued interest is outpacing it.`,
      "Increase the chunk size by lowering hfFloor, or repay some debt from the wallet balance to break the deadlock.",
      false,
    );
  }
}

// ── Control 5 — quote and price impact ───────────────────────────────────────

/**
 * Compare the swap's effective price against the AaveOracle price.
 *
 * The oracle is the reference Aave itself uses for liquidations, so a swap far off
 * it means thin liquidity or a manipulated pool — either way, executing would
 * realise a loss the position cannot afford mid-deleverage.
 */
export function assertPriceImpact(args: {
  amountIn: bigint;
  quotedOut: bigint;
  priceInBase: bigint; // oracle price of tokenIn, base currency
  priceOutBase: bigint; // oracle price of tokenOut
  decimalsIn: number;
  decimalsOut: number;
  maxBps: number;
}): void {
  if (args.quotedOut <= 0n) {
    fail("no-quote", "No swap quote available for this leg (no route or no liquidity).", "Try a different fee tier or asset pair.");
  }
  // Oracle-implied output, in tokenOut units.
  const inValue = (args.amountIn * args.priceInBase) / 10n ** BigInt(args.decimalsIn);
  const fair = (inValue * 10n ** BigInt(args.decimalsOut)) / args.priceOutBase;
  if (fair === 0n) return;
  if (args.quotedOut >= fair) return; // better than oracle — no complaint
  const shortfallBps = Number(((fair - args.quotedOut) * 10000n) / fair);
  if (shortfallBps > args.maxBps) {
    fail(
      "price-impact",
      `The swap would execute ${shortfallBps} bps below the Aave oracle price (limit ${args.maxBps}).`,
      "Use smaller chunks (lower hfFloor or minimumChunkAmount), pick a deeper fee tier, or wait for better liquidity.",
    );
  }
}

// ── Control 6 — Aave reserve state ───────────────────────────────────────────

export interface ReserveLegCheck {
  reserve: AaveReserveInfo;
  /** What the chunk does with this reserve. */
  leg: "withdraw" | "supply" | "borrow" | "repay";
  /** Amount involved, in the reserve's own units. */
  amount: bigint;
}

/**
 * Reject a leg the reserve itself would refuse, before building the batch.
 * Caps are expressed in whole tokens by Aave, hence the decimals scaling.
 */
export function assertReserveUsable(check: ReserveLegCheck): void {
  const r = check.reserve;
  const name = r.symbol ?? r.asset;
  if (!r.isActive || r.isPaused) {
    fail("reserve-unavailable", `Reserve ${name} is ${r.isPaused ? "paused" : "inactive"}.`, "Wait for Aave to re-enable it.", false);
  }
  // Frozen still allows repay and withdraw — only new exposure is blocked.
  if (r.isFrozen && (check.leg === "supply" || check.leg === "borrow")) {
    fail("reserve-unavailable", `Reserve ${name} is frozen: no new ${check.leg} allowed.`, "Withdraw/repay still work; pick another asset for new exposure.", false);
  }
  if (check.leg === "borrow" && !r.borrowingEnabled) {
    fail("reserve-unavailable", `Borrowing is disabled for ${name}.`, "Choose a different debt asset.", false);
  }
  const whole = 10n ** BigInt(r.decimals);
  if (check.leg === "supply" && r.supplyCap > 0n) {
    const headroom = r.supplyCap * whole - r.totalSupplied;
    if (check.amount > headroom) {
      fail("cap-exceeded", `Supplying ${name} would exceed its supply cap.`, "Use a smaller chunk or a different asset.");
    }
  }
  if (check.leg === "borrow" && r.borrowCap > 0n) {
    const headroom = r.borrowCap * whole - r.totalVariableDebt;
    if (check.amount > headroom) {
      fail("cap-exceeded", `Borrowing ${name} would exceed its borrow cap.`, "Use a smaller chunk or a different asset.");
    }
  }
  if (check.leg === "borrow" && r.siloedBorrowing) {
    fail(
      "siloed-borrowing",
      `${name} is a siloed asset: it must be the only debt in the position.`,
      "Repay other debts first, or borrow a non-siloed asset.",
      false,
    );
  }
  if (check.leg === "supply" && r.debtCeiling > 0n) {
    fail(
      "isolation-mode",
      `${name} is in isolation mode; supplying it constrains what can be borrowed against it.`,
      "Use a non-isolated asset as collateral for this operation.",
      false,
    );
  }
}

// ── Control 8 — the dangerous moment INSIDE a swap chunk ─────────────────────

/**
 * Guard the intermediate state a collateral or debt swap passes through.
 *
 * These two chunks are riskier than a deleverage, and for a reason that is easy to
 * miss: the batch is atomic, but Aave checks health *per operation* inside it.
 *
 *  - Collateral swap withdraws asset A before supplying asset B, so for one
 *    instant the position is under-collateralised by the whole chunk.
 *  - Debt swap borrows B before repaying A, so for one instant the position owes
 *    MORE than when it started.
 *
 * Sizing a chunk on the *final* state alone would happily build a batch that Aave
 * rejects mid-way — or worse, one that only just passes and leaves no margin. So
 * the floor is applied to the worst moment, not the end result.
 */
export function assertIntermediateHealth(args: {
  /** HF at the worst point inside the chunk, 1e18. */
  intermediateHf: bigint;
  hfFloorWad: bigint;
  operation: "collateral-swap" | "debt-swap";
}): void {
  if (args.intermediateHf >= args.hfFloorWad) return;
  const where =
    args.operation === "collateral-swap"
      ? "after withdrawing the old collateral but before the new one is supplied"
      : "after borrowing the new debt but before the old one is repaid";
  fail(
    "position-too-tight",
    `The chunk would dip to a health factor of ${(Number(args.intermediateHf) / 1e18).toFixed(3)} ${where}, below the floor of ${(
      Number(args.hfFloorWad) / 1e18
    ).toFixed(2)}.`,
    "Use a smaller chunk (lower minimumChunkAmount), or lower hfFloor if you accept the tighter margin.",
  );
}

/** The destination reserve of a collateral swap has to actually count as collateral. */
export function assertUsableAsCollateral(reserve: AaveReserveInfo): void {
  if (!reserve.usageAsCollateralEnabled) {
    fail(
      "reserve-unavailable",
      `${reserve.symbol ?? reserve.asset} cannot be used as collateral on Aave.`,
      "Pick a different destination asset — swapping into this one would leave the position unbacked.",
      false,
    );
  }
}

/**
 * A siloed asset must be a user's ONLY debt, which constrains debt swaps in both
 * directions: you cannot borrow into a siloed asset while another debt is still
 * open, and you cannot add a second debt on top of an existing siloed one.
 */
export function assertSiloedCompatible(from: AaveReserveInfo, to: AaveReserveInfo): void {
  if (to.siloedBorrowing) {
    fail(
      "siloed-borrowing",
      `${to.symbol ?? to.asset} is siloed: it must be the only debt, but the swap borrows it while ${
        from.symbol ?? from.asset
      } is still owed.`,
      "Repay the existing debt in full first, then borrow the siloed asset.",
      false,
    );
  }
  if (from.siloedBorrowing) {
    fail(
      "siloed-borrowing",
      `${from.symbol ?? from.asset} is siloed, so no second debt can be opened alongside it to swap into.`,
      "Repay it from wallet balance or by deleveraging instead of swapping the debt.",
      false,
    );
  }
}

// ── Control 7 — the agent's own budget across the WHOLE plan ─────────────────

/**
 * Check the agent can afford every approval the plan will make, before chunk 1.
 *
 * Approvals inside a batch accumulate against the per-token limits (the wallet
 * sums them in `tokenAccumulated`), and each chunk approves twice — the router for
 * the collateral, the Pool for the debt. Discovering the budget ran out at chunk 7
 * leaves the position half-deleveraged, so it is checked up front.
 */
export function assertBudget(args: {
  token: Address;
  symbol: string;
  required: bigint;
  remaining: bigint | null; // null = unlimited
  fmt: (v: bigint) => string;
}): void {
  if (args.remaining == null) return;
  if (args.required > args.remaining) {
    fail(
      "insufficient-budget",
      `The plan needs ${args.fmt(args.required)} of ${args.symbol} in approvals but the agent has ${args.fmt(
        args.remaining,
      )} left.`,
      `Raise the agent's ${args.symbol} limits by ${args.fmt(args.required - args.remaining)}, or run the plan in stages.`,
    );
  }
}

// ── Chunk arithmetic ─────────────────────────────────────────────────────────

/**
 * The repay amount to encode for a chunk.
 *
 * Two fees are charged per chunk — the wallet takes 0.15% of the withdrawal and
 * 0.15% of the swap output, because the contract snapshots per execution rather
 * than netting the batch. So from a quote floor Q the wallet is only guaranteed
 * `Q × 0.9985`, and encoding anything larger risks reverting the whole chunk on a
 * balance it does not have.
 */
export function repayAmountForChunk(quoteFloor: bigint): bigint {
  return netOfFee(quoteFloor);
}

/** Collateral actually available to swap after the withdrawal's own fee. */
export function swappableAfterWithdraw(chunk: bigint): bigint {
  return netOfFee(chunk);
}
