/**
 * Aave plans — deleveraging and closing a position.
 *
 * A plan is a *projection*: it simulates the loop forward to show how many chunks
 * it will take, where the health factor lands and what it costs. Execution never
 * replays that calldata — `executePlan` re-derives each chunk from live state, so
 * price moves and accrued interest between chunks are always accounted for. The
 * plan is what you show; the executor is what you trust.
 */
import { formatUnits, parseUnits, type Address } from "viem";

import type { BvccAgentClient } from "../client.js";
import { applySlippage, quoteV3ExactInputSingle } from "../quote.js";
import { resolveToken } from "../tokens.js";
import type { Execution } from "../types.js";
import { getAaveAddresses } from "./addresses.js";
import {
  assertBudget,
  assertChunkAboveMinimum,
  assertIterationsLeft,
  assertIntermediateHealth,
  assertPositionWorkable,
  assertPriceImpact,
  assertSiloedCompatible,
  assertUsableAsCollateral,
  assertProgress,
  assertReserveUsable,
  PlannerError,
  repayAmountForChunk,
  resolveControls,
  swappableAfterWithdraw,
  type AavePlannerControls,
  type ResolvedControls,
} from "./planner.js";
import {
  getAccountData,
  getReserves,
  healthFactorFromWeighted,
  maxSafeBorrowBase,
  weightedCollateralBase,
  getUserPositions,
  maxSafeWithdrawBase,
  projectHealthFactor,
  type AaveReserveInfo,
  type RiskInput,
} from "./read.js";
import { buildBorrow, buildRepay, buildRepayWithATokens, buildSetCollateral, buildSupply, buildWithdraw } from "./write.js";

export interface AavePlanChunk {
  description: string;
  /** ONE atomic batch = one executeAsAgent tx. All-or-nothing. */
  executions: Execution[];
  projectedHealthFactorAfter: bigint;
  projectedDebtAfter: bigint;
  bvccFeeEstimates: { token: Address; symbol: string; amount: bigint }[];
}

export interface AavePlan {
  kind: "repayWithCollateral" | "closePosition" | "collateralSwap" | "debtSwap";
  /** "direct" and "aTokens" close without any swap; "chunked" runs the loop. */
  strategy: "direct" | "aTokens" | "chunked";
  chunks: AavePlanChunk[];
  requiredProtocols: Address[];
  requiredTokens: Address[];
  requiredBudgets: { token: Address; symbol: string; amount: bigint }[];
  totalBvccFees: { token: Address; symbol: string; amount: bigint }[];
  warnings: string[];
  controls: ResolvedControls;
  summary: string;
}

export interface AavePlanExecution {
  ok: boolean;
  kind: AavePlan["kind"];
  chunksCompleted: number;
  txHashes: `0x${string}`[];
  /** Debt still outstanding, in the debt asset's units. */
  pendingRemaining: bigint;
  failure: { reason: string; message: string; suggestedAction: string } | null;
}

const WAD = 10n ** 18n;

/** Convert an amount of `asset` into the oracle's base currency (1e8 USD). */
const toBase = (amount: bigint, priceBase: bigint, decimals: number) =>
  (amount * priceBase) / 10n ** BigInt(decimals);

/** Convert a base-currency amount into units of `asset`. */
const fromBase = (base: bigint, priceBase: bigint, decimals: number) =>
  priceBase === 0n ? 0n : (base * 10n ** BigInt(decimals)) / priceBase;

const priceOf = (r: AaveReserveInfo) => BigInt(Math.round(Number(r.priceUsd) * 1e8));

async function loadContext(client: BvccAgentClient, assets: string[]) {
  const chainId = client.network.chainId;
  const addrs = getAaveAddresses(chainId);
  if (!addrs) throw new Error(`Aave is not supported on chain ${chainId} in this SDK.`);
  const [account, positions, reserves] = await Promise.all([
    getAccountData(client.publicClient, chainId, client.walletAddress),
    getUserPositions(client.publicClient, chainId, client.walletAddress),
    getReserves(client.publicClient, chainId, assets),
  ]);
  return { addrs, account, positions, reserves };
}

/**
 * Plan a chunked deleverage: sell collateral to repay debt, in safe steps.
 *
 * The loop is simulated forward here — after each projected chunk the collateral
 * and debt are reduced, which is what frees room for the next one. That is the
 * whole mechanism: repaying is what makes more collateral withdrawable.
 */
export async function planRepayWithCollateral(
  client: BvccAgentClient,
  params: {
    collateralAsset: string;
    debtAsset: string;
    /** Debt to clear, in debt-asset units, or "all". */
    amount?: string | "all";
    fee?: number;
  } & AavePlannerControls,
): Promise<AavePlan> {
  const controls = resolveControls(params);
  const hfFloorWad = parseUnits(controls.hfFloor, 18);
  const { addrs, account, positions, reserves } = await loadContext(client, [
    params.collateralAsset,
    params.debtAsset,
  ]);

  const collAddr = resolveToken(client.network.chainId, params.collateralAsset).address;
  const debtAddr = resolveToken(client.network.chainId, params.debtAsset).address;
  const collRes = reserves.find((r) => r.asset.toLowerCase() === collAddr.toLowerCase());
  const debtRes = reserves.find((r) => r.asset.toLowerCase() === debtAddr.toLowerCase());
  if (!collRes || !debtRes) throw new Error("Could not read the Aave reserves for those assets.");

  assertReserveUsable({ reserve: collRes, leg: "withdraw", amount: 0n });
  assertReserveUsable({ reserve: debtRes, leg: "repay", amount: 0n });

  const collPrice = priceOf(collRes);
  const debtPrice = priceOf(debtRes);
  const fmtBase = (v: bigint) => `$${(Number(v) / 1e8).toFixed(2)}`;
  const fmtColl = (v: bigint) => `${formatUnits(v, collRes.decimals)} ${collRes.symbol ?? ""}`.trim();
  const fmtDebt = (v: bigint) => `${formatUnits(v, debtRes.decimals)} ${debtRes.symbol ?? ""}`.trim();

  const debtPos = positions.find((p) => p.asset.toLowerCase() === debtAddr.toLowerCase());
  const totalDebt = debtPos?.variableDebt ?? 0n;
  if (totalDebt === 0n) {
    return emptyPlan("repayWithCollateral", controls, "There is no debt in that asset to repay.");
  }
  const targetDebt =
    params.amount == null || params.amount === "all"
      ? totalDebt
      : minBig(parseUnits(params.amount, debtRes.decimals), totalDebt);

  // Live risk snapshot; mutated as the loop is simulated forward.
  let state: RiskInput = {
    totalCollateralBase: account.totalCollateralBase,
    totalDebtBase: account.totalDebtBase,
    liquidationThresholdBps: account.currentLiquidationThreshold,
  };
  assertPositionWorkable(state, hfFloorWad, fmtBase);

  const router = client.network.swapRouter02;
  if (!router) throw new Error(`No swapRouter02 configured for ${client.network.name}.`);
  const quoter = client.network.quoterV2;
  const fee = params.fee ?? 500;
  const minChunk = parseUnits(controls.minimumChunkAmount, collRes.decimals);

  const chunks: AavePlanChunk[] = [];
  const warnings: string[] = [];
  let pending = targetDebt;
  let collApprovals = 0n;
  let debtApprovals = 0n;
  let feeColl = 0n;
  let feeDebt = 0n;

  for (let i = 0; i < controls.maximumIterations && pending > 0n; i++) {
    // How much collateral may leave while staying above the floor…
    const roomBase = maxSafeWithdrawBase(state, hfFloorWad);
    if (roomBase === 0n) {
      warnings.push(`Stopped after ${i} chunk(s): no further collateral can be withdrawn at this floor.`);
      break;
    }
    // …capped by what is actually still needed to clear the debt.
    const neededBase = toBase(pending, debtPrice, debtRes.decimals);
    const chunkBase = minBig(roomBase, (neededBase * 10200n) / 10000n); // 2% headroom for fees/slippage
    let chunk = fromBase(chunkBase, collPrice, collRes.decimals);
    const suppliedColl = positions.find((p) => p.asset.toLowerCase() === collAddr.toLowerCase())?.supplied ?? 0n;
    chunk = minBig(chunk, suppliedColl);
    if (chunk === 0n) break;
    assertChunkAboveMinimum(chunk, minChunk, fmtColl);

    // Quote the swap on what survives the withdrawal's own fee.
    const swappable = swappableAfterWithdraw(chunk);
    let rawQuote = 0n;
    if (quoter) {
      try {
        rawQuote = await quoteV3ExactInputSingle(client.publicClient, quoter, {
          tokenIn: collAddr,
          tokenOut: debtAddr,
          amountIn: swappable,
          fee,
        });
      } catch {
        rawQuote = 0n;
      }
    }
    assertPriceImpact({
      amountIn: swappable,
      quotedOut: rawQuote,
      priceInBase: collPrice,
      priceOutBase: debtPrice,
      decimalsIn: collRes.decimals,
      decimalsOut: debtRes.decimals,
      maxBps: controls.maxPriceImpactBps,
    });

    const quoteFloor = applySlippage(rawQuote, controls.slippageBps);
    const repayAmount = minBig(repayAmountForChunk(quoteFloor), pending);
    if (repayAmount === 0n) break;

    const executions: Execution[] = [
      ...buildWithdraw(addrs.pool, client.walletAddress, collAddr, chunk),
      ...client.buildSwapExactInputV3({
        tokenIn: collAddr,
        tokenOut: debtAddr,
        amountIn: swappable,
        amountOutMinimum: quoteFloor,
        fee,
        router,
      }),
      ...buildRepay(addrs.pool, client.walletAddress, debtAddr, repayAmount, repayAmount),
    ];

    // Project the position forward — this is what frees room for the next chunk.
    const repaidBase = toBase(repayAmount, debtPrice, debtRes.decimals);
    state = {
      ...state,
      totalCollateralBase: state.totalCollateralBase - chunkBase,
      totalDebtBase: bigMax(state.totalDebtBase - repaidBase, 0n),
    };
    pending = bigMax(pending - repayAmount, 0n);
    collApprovals += swappable;
    debtApprovals += repayAmount;
    feeColl += chunk - swappable;
    feeDebt += quoteFloor - repayAmount;

    chunks.push({
      description: `withdraw ${fmtColl(chunk)} → swap → repay ${fmtDebt(repayAmount)}`,
      executions,
      projectedHealthFactorAfter: projectHealthFactor(state),
      projectedDebtAfter: pending,
      bvccFeeEstimates: [
        { token: collAddr, symbol: collRes.symbol ?? "", amount: chunk - swappable },
        { token: debtAddr, symbol: debtRes.symbol ?? "", amount: quoteFloor - repayAmount },
      ],
    });
  }

  if (pending > 0n && chunks.length >= controls.maximumIterations) {
    warnings.push(
      `The projection needs more than ${controls.maximumIterations} chunks; ${fmtDebt(pending)} would remain.`,
    );
  }

  // Budget check across the WHOLE plan, before chunk 1 — approvals accumulate.
  const remaining = await client.getRemaining();
  for (const [token, symbol, required, decimals] of [
    [collAddr, collRes.symbol ?? "", collApprovals, collRes.decimals],
    [debtAddr, debtRes.symbol ?? "", debtApprovals, debtRes.decimals],
  ] as const) {
    const budget = remaining.tokens.find((t) => t.token.toLowerCase() === token.toLowerCase());
    assertBudget({
      token,
      symbol,
      required,
      remaining: budget ? budget.totalRemaining : null,
      fmt: (v) => `${formatUnits(v, decimals)} ${symbol}`.trim(),
    });
  }

  return {
    kind: "repayWithCollateral",
    strategy: "chunked",
    chunks,
    requiredProtocols: [addrs.pool, router],
    requiredTokens: [collAddr, debtAddr],
    requiredBudgets: [
      { token: collAddr, symbol: collRes.symbol ?? "", amount: collApprovals },
      { token: debtAddr, symbol: debtRes.symbol ?? "", amount: debtApprovals },
    ],
    totalBvccFees: [
      { token: collAddr, symbol: collRes.symbol ?? "", amount: feeColl },
      { token: debtAddr, symbol: debtRes.symbol ?? "", amount: feeDebt },
    ],
    warnings,
    controls,
    summary:
      `${chunks.length} chunk(s) to repay ${fmtDebt(targetDebt - pending)} of ${fmtDebt(targetDebt)}` +
      (pending > 0n ? ` (${fmtDebt(pending)} would remain)` : " (full)"),
  };
}

/**
 * Plan closing a position, choosing the cheapest viable route.
 *
 * Chunking is the last resort: it costs two fees per chunk plus swap slippage.
 * Two shortcuts avoid it entirely and are checked first.
 */
export async function planClosePosition(
  client: BvccAgentClient,
  params: { fee?: number } & AavePlannerControls,
): Promise<AavePlan> {
  const controls = resolveControls(params);
  const { addrs, positions } = await loadContext(client, []);

  const debts = positions.filter((p) => p.variableDebt > 0n);
  const collaterals = positions.filter((p) => p.supplied > 0n);

  if (debts.length === 0) {
    if (collaterals.length === 0) {
      return emptyPlan("closePosition", controls, "There is no Aave position to close.");
    }
    // No debt: everything is simply withdrawable.
    const chunks: AavePlanChunk[] = collaterals.map((c) => ({
      description: `withdraw all ${c.symbol ?? ""}`.trim(),
      executions: buildWithdraw(addrs.pool, client.walletAddress, c.asset, "max"),
      projectedHealthFactorAfter: (1n << 256n) - 1n,
      projectedDebtAfter: 0n,
      bvccFeeEstimates: [
        { token: c.asset, symbol: c.symbol ?? "", amount: (c.supplied * 15n) / 10000n },
      ],
    }));
    return {
      kind: "closePosition",
      strategy: "direct",
      chunks,
      requiredProtocols: [addrs.pool],
      requiredTokens: collaterals.map((c) => c.asset),
      requiredBudgets: [],
      totalBvccFees: chunks.flatMap((c) => c.bvccFeeEstimates),
      warnings: [],
      controls,
      summary: `No debt — withdrawing ${collaterals.length} collateral position(s).`,
    };
  }

  if (debts.length > 1) {
    throw new PlannerError({
      reason: "no-progress",
      message: `The position has ${debts.length} different debts; closing them together is not supported yet.`,
      suggestedAction: "Repay the smaller debts individually first, then close the remaining one.",
      recoverable: true,
    });
  }

  const debt = debts[0];
  const walletHas = (await client.getTokenBalance(debt.asset)).raw;

  // Route 1 — the wallet can just pay it off. No loop, no swap, no price impact.
  if (walletHas >= debt.variableDebt) {
    const executions: Execution[] = [
      ...buildRepay(addrs.pool, client.walletAddress, debt.asset, "max", (debt.variableDebt * 10010n) / 10000n),
      ...collaterals.flatMap((c) => buildWithdraw(addrs.pool, client.walletAddress, c.asset, "max")),
    ];
    return {
      kind: "closePosition",
      strategy: "direct",
      chunks: [
        {
          description: `repay all ${debt.symbol ?? ""} from wallet balance, then withdraw all collateral`.trim(),
          executions,
          projectedHealthFactorAfter: (1n << 256n) - 1n,
          projectedDebtAfter: 0n,
          bvccFeeEstimates: collaterals.map((c) => ({
            token: c.asset,
            symbol: c.symbol ?? "",
            amount: (c.supplied * 15n) / 10000n,
          })),
        },
      ],
      requiredProtocols: [addrs.pool],
      requiredTokens: [debt.asset, ...collaterals.map((c) => c.asset)],
      requiredBudgets: [
        { token: debt.asset, symbol: debt.symbol ?? "", amount: (debt.variableDebt * 10010n) / 10000n },
      ],
      totalBvccFees: collaterals.map((c) => ({
        token: c.asset,
        symbol: c.symbol ?? "",
        amount: (c.supplied * 15n) / 10000n,
      })),
      warnings: [],
      controls,
      summary: "Wallet balance covers the debt — closing in a single transaction, no swaps.",
    };
  }

  // Route 2 — debt and collateral are the same asset: burn aTokens against it.
  // No swap, and no BVCC fee at all (nothing enters the wallet).
  const sameAsset = collaterals.find((c) => c.asset.toLowerCase() === debt.asset.toLowerCase());
  if (sameAsset && sameAsset.supplied >= debt.variableDebt) {
    const executions: Execution[] = [
      ...buildRepayWithATokens(addrs.pool, debt.asset, "max"),
      ...collaterals.flatMap((c) => buildWithdraw(addrs.pool, client.walletAddress, c.asset, "max")),
    ];
    return {
      kind: "closePosition",
      strategy: "aTokens",
      chunks: [
        {
          description: `repay ${debt.symbol ?? ""} with its own aTokens, then withdraw the rest`.trim(),
          executions,
          projectedHealthFactorAfter: (1n << 256n) - 1n,
          projectedDebtAfter: 0n,
          bvccFeeEstimates: [],
        },
      ],
      requiredProtocols: [addrs.pool],
      requiredTokens: [debt.asset],
      requiredBudgets: [],
      totalBvccFees: [],
      warnings: [],
      controls,
      summary: "Debt and collateral are the same asset — repaying from aTokens, no swap and no fee.",
    };
  }

  // Route 3 — the loop.
  const biggest = collaterals.reduce((a, b) => (a.supplied > b.supplied ? a : b));
  const plan = await planRepayWithCollateral(client, {
    ...params,
    collateralAsset: biggest.asset,
    debtAsset: debt.asset,
    amount: "all",
  });
  const finalWithdraw: AavePlanChunk = {
    description: "withdraw all remaining collateral",
    executions: collaterals.flatMap((c) => buildWithdraw(addrs.pool, client.walletAddress, c.asset, "max")),
    projectedHealthFactorAfter: (1n << 256n) - 1n,
    projectedDebtAfter: 0n,
    bvccFeeEstimates: [],
  };
  return {
    ...plan,
    kind: "closePosition",
    strategy: "chunked",
    chunks: [...plan.chunks, finalWithdraw],
    summary: `${plan.chunks.length} deleverage chunk(s), then withdraw everything.`,
  };
}

/**
 * Swap the collateral backing a position from one asset to another.
 *
 * Chunk: `withdraw(A) → swap A→B → supply(B)`. The binding constraint is not the
 * end state but the middle: Aave checks health when the withdrawal happens, before
 * the replacement collateral exists. So each chunk is sized on that dip.
 *
 * Health can also move for a second reason — assets have different liquidation
 * thresholds, so swapping into a weaker one lowers the health factor even at
 * identical value. That is why the projection works from the weighted sum rather
 * than assuming the blended threshold holds.
 */
export async function planCollateralSwap(
  client: BvccAgentClient,
  params: { fromAsset: string; toAsset: string; amount?: string | "all"; fee?: number } & AavePlannerControls,
): Promise<AavePlan> {
  const controls = resolveControls(params);
  const hfFloorWad = parseUnits(controls.hfFloor, 18);
  const { addrs, account, positions, reserves } = await loadContext(client, [params.fromAsset, params.toAsset]);

  const fromAddr = resolveToken(client.network.chainId, params.fromAsset).address;
  const toAddr = resolveToken(client.network.chainId, params.toAsset).address;
  const fromRes = reserves.find((r) => r.asset.toLowerCase() === fromAddr.toLowerCase());
  const toRes = reserves.find((r) => r.asset.toLowerCase() === toAddr.toLowerCase());
  if (!fromRes || !toRes) throw new Error("Could not read the Aave reserves for those assets.");
  if (fromAddr.toLowerCase() === toAddr.toLowerCase()) {
    throw new Error("fromAsset and toAsset are the same — nothing to swap.");
  }

  assertReserveUsable({ reserve: fromRes, leg: "withdraw", amount: 0n });
  assertUsableAsCollateral(toRes);

  const fromPos = positions.find((p) => p.asset.toLowerCase() === fromAddr.toLowerCase());
  const supplied = fromPos?.supplied ?? 0n;
  if (supplied === 0n) return emptyPlan("collateralSwap", controls, "There is no collateral in that asset to migrate.");

  const fromPrice = priceOf(fromRes);
  const toPrice = priceOf(toRes);
  const fmtFrom = (v: bigint) => `${formatUnits(v, fromRes.decimals)} ${fromRes.symbol ?? ""}`.trim();
  const fmtTo = (v: bigint) => `${formatUnits(v, toRes.decimals)} ${toRes.symbol ?? ""}`.trim();
  const fmtBase = (v: bigint) => `$${(Number(v) / 1e8).toFixed(2)}`;

  const target =
    params.amount == null || params.amount === "all"
      ? supplied
      : minBig(parseUnits(params.amount, fromRes.decimals), supplied);

  let state: RiskInput = {
    totalCollateralBase: account.totalCollateralBase,
    totalDebtBase: account.totalDebtBase,
    liquidationThresholdBps: account.currentLiquidationThreshold,
  };
  let weighted = weightedCollateralBase(state);

  const router = client.network.swapRouter02;
  if (!router) throw new Error(`No swapRouter02 configured for ${client.network.name}.`);
  const quoter = client.network.quoterV2;
  const fee = params.fee ?? 500;
  const minChunk = parseUnits(controls.minimumChunkAmount, fromRes.decimals);

  const chunks: AavePlanChunk[] = [];
  const warnings: string[] = [];
  let pending = target;
  let fromApprovals = 0n;
  let toApprovals = 0n;
  let feeFrom = 0n;
  let feeTo = 0n;

  for (let i = 0; i < controls.maximumIterations && pending > 0n; i++) {
    // Sized on the dip: how much may leave before the replacement lands.
    const roomBase = state.totalDebtBase === 0n ? toBase(pending, fromPrice, fromRes.decimals) : maxSafeWithdrawBase(state, hfFloorWad);
    if (roomBase === 0n) {
      warnings.push(`Stopped after ${i} chunk(s): no collateral can be withdrawn at this floor.`);
      break;
    }
    let chunk = minBig(fromBase(roomBase, fromPrice, fromRes.decimals), pending);
    if (chunk === 0n) break;
    assertChunkAboveMinimum(chunk, minChunk, fmtFrom);

    // The intermediate moment: collateral gone, replacement not yet supplied.
    const chunkBase = toBase(chunk, fromPrice, fromRes.decimals);
    const intermediate = healthFactorFromWeighted(
      weighted - (chunkBase * BigInt(fromRes.liquidationThresholdBps)) / 10000n,
      state.totalDebtBase,
    );
    assertIntermediateHealth({ intermediateHf: intermediate, hfFloorWad, operation: "collateral-swap" });

    const swappable = swappableAfterWithdraw(chunk);
    let rawQuote = 0n;
    if (quoter) {
      try {
        rawQuote = await quoteV3ExactInputSingle(client.publicClient, quoter, {
          tokenIn: fromAddr,
          tokenOut: toAddr,
          amountIn: swappable,
          fee,
        });
      } catch {
        rawQuote = 0n;
      }
    }
    assertPriceImpact({
      amountIn: swappable,
      quotedOut: rawQuote,
      priceInBase: fromPrice,
      priceOutBase: toPrice,
      decimalsIn: fromRes.decimals,
      decimalsOut: toRes.decimals,
      maxBps: controls.maxPriceImpactBps,
    });

    const quoteFloor = applySlippage(rawQuote, controls.slippageBps);
    const supplyAmount = repayAmountForChunk(quoteFloor); // same guaranteed-minimum logic
    if (supplyAmount === 0n) break;
    assertReserveUsable({ reserve: toRes, leg: "supply", amount: supplyAmount });

    const executions: Execution[] = [
      ...buildWithdraw(addrs.pool, client.walletAddress, fromAddr, chunk),
      ...client.buildSwapExactInputV3({
        tokenIn: fromAddr,
        tokenOut: toAddr,
        amountIn: swappable,
        amountOutMinimum: quoteFloor,
        fee,
        router,
      }),
      ...buildSupply(addrs.pool, client.walletAddress, toAddr, supplyAmount),
    ];

    const suppliedBase = toBase(supplyAmount, toPrice, toRes.decimals);
    weighted =
      weighted -
      (chunkBase * BigInt(fromRes.liquidationThresholdBps)) / 10000n +
      (suppliedBase * BigInt(toRes.liquidationThresholdBps)) / 10000n;
    state = { ...state, totalCollateralBase: state.totalCollateralBase - chunkBase + suppliedBase };
    pending = bigMax(pending - chunk, 0n);
    fromApprovals += swappable;
    toApprovals += supplyAmount;
    feeFrom += chunk - swappable;
    feeTo += quoteFloor - supplyAmount;

    chunks.push({
      description: `withdraw ${fmtFrom(chunk)} → swap → supply ${fmtTo(supplyAmount)}`,
      executions,
      projectedHealthFactorAfter: healthFactorFromWeighted(weighted, state.totalDebtBase),
      projectedDebtAfter: pending,
      bvccFeeEstimates: [
        { token: fromAddr, symbol: fromRes.symbol ?? "", amount: chunk - swappable },
        { token: toAddr, symbol: toRes.symbol ?? "", amount: quoteFloor - supplyAmount },
      ],
    });
  }

  // If the destination is not yet flagged as collateral, turn it on — otherwise
  // the migrated value would sit there without backing anything.
  const toPos = positions.find((p) => p.asset.toLowerCase() === toAddr.toLowerCase());
  if (chunks.length > 0 && !(toPos?.usageAsCollateralEnabled ?? false)) {
    chunks.push({
      description: `enable ${toRes.symbol ?? ""} as collateral`.trim(),
      executions: buildSetCollateral(addrs.pool, toAddr, true),
      projectedHealthFactorAfter: healthFactorFromWeighted(weighted, state.totalDebtBase),
      projectedDebtAfter: 0n,
      bvccFeeEstimates: [],
    });
  }

  await assertPlanBudget(client, [
    [fromAddr, fromRes.symbol ?? "", fromApprovals, fromRes.decimals],
    [toAddr, toRes.symbol ?? "", toApprovals, toRes.decimals],
  ]);

  void fmtBase;
  return {
    kind: "collateralSwap",
    strategy: "chunked",
    chunks,
    requiredProtocols: [addrs.pool, router],
    requiredTokens: [fromAddr, toAddr],
    requiredBudgets: [
      { token: fromAddr, symbol: fromRes.symbol ?? "", amount: fromApprovals },
      { token: toAddr, symbol: toRes.symbol ?? "", amount: toApprovals },
    ],
    totalBvccFees: [
      { token: fromAddr, symbol: fromRes.symbol ?? "", amount: feeFrom },
      { token: toAddr, symbol: toRes.symbol ?? "", amount: feeTo },
    ],
    warnings,
    controls,
    summary: `${chunks.length} chunk(s) migrating ${fmtFrom(target - pending)} of collateral into ${toRes.symbol ?? ""}`.trim(),
  };
}

/**
 * Swap a debt from one asset to another.
 *
 * Chunk: `borrow(B) → swap B→A → repay(A)`. The dangerous instant is the borrow:
 * for that moment the position carries BOTH debts, so it is briefly more levered
 * than when it started. Each chunk is sized against that peak, not the end state.
 */
export async function planDebtSwap(
  client: BvccAgentClient,
  params: { fromDebtAsset: string; toDebtAsset: string; amount?: string | "all"; fee?: number } & AavePlannerControls,
): Promise<AavePlan> {
  const controls = resolveControls(params);
  const hfFloorWad = parseUnits(controls.hfFloor, 18);
  const { addrs, account, positions, reserves } = await loadContext(client, [
    params.fromDebtAsset,
    params.toDebtAsset,
  ]);

  const fromAddr = resolveToken(client.network.chainId, params.fromDebtAsset).address;
  const toAddr = resolveToken(client.network.chainId, params.toDebtAsset).address;
  const fromRes = reserves.find((r) => r.asset.toLowerCase() === fromAddr.toLowerCase());
  const toRes = reserves.find((r) => r.asset.toLowerCase() === toAddr.toLowerCase());
  if (!fromRes || !toRes) throw new Error("Could not read the Aave reserves for those assets.");
  if (fromAddr.toLowerCase() === toAddr.toLowerCase()) {
    throw new Error("fromDebtAsset and toDebtAsset are the same — nothing to swap.");
  }

  assertReserveUsable({ reserve: fromRes, leg: "repay", amount: 0n });
  assertSiloedCompatible(fromRes, toRes);

  const fromPos = positions.find((p) => p.asset.toLowerCase() === fromAddr.toLowerCase());
  const debt = fromPos?.variableDebt ?? 0n;
  if (debt === 0n) return emptyPlan("debtSwap", controls, "There is no debt in that asset to swap.");

  const fromPrice = priceOf(fromRes);
  const toPrice = priceOf(toRes);
  const fmtFrom = (v: bigint) => `${formatUnits(v, fromRes.decimals)} ${fromRes.symbol ?? ""}`.trim();
  const fmtTo = (v: bigint) => `${formatUnits(v, toRes.decimals)} ${toRes.symbol ?? ""}`.trim();

  const target =
    params.amount == null || params.amount === "all"
      ? debt
      : minBig(parseUnits(params.amount, fromRes.decimals), debt);

  let state: RiskInput = {
    totalCollateralBase: account.totalCollateralBase,
    totalDebtBase: account.totalDebtBase,
    liquidationThresholdBps: account.currentLiquidationThreshold,
  };
  const weighted = weightedCollateralBase(state); // collateral untouched by a debt swap

  const router = client.network.swapRouter02;
  if (!router) throw new Error(`No swapRouter02 configured for ${client.network.name}.`);
  const quoter = client.network.quoterV2;
  const fee = params.fee ?? 500;
  const minChunk = parseUnits(controls.minimumChunkAmount, toRes.decimals);

  const chunks: AavePlanChunk[] = [];
  const warnings: string[] = [];
  let pending = target;
  let toApprovals = 0n;
  let fromApprovals = 0n;
  let feeTo = 0n;
  let feeFrom = 0n;

  for (let i = 0; i < controls.maximumIterations && pending > 0n; i++) {
    // Room to take on MORE debt for an instant, before the old one is cleared.
    const roomBase = maxSafeBorrowBase(state, hfFloorWad);
    if (roomBase === 0n) {
      warnings.push(`Stopped after ${i} chunk(s): no additional debt can be taken on at this floor.`);
      break;
    }
    const neededBase = toBase(pending, fromPrice, fromRes.decimals);
    const chunkBase = minBig(roomBase, (neededBase * 10200n) / 10000n);
    const borrowAmount = fromBase(chunkBase, toPrice, toRes.decimals);
    if (borrowAmount === 0n) break;
    assertChunkAboveMinimum(borrowAmount, minChunk, fmtTo);
    assertReserveUsable({ reserve: toRes, leg: "borrow", amount: borrowAmount });

    // The peak: both debts outstanding at once.
    const peak = healthFactorFromWeighted(weighted, state.totalDebtBase + chunkBase);
    assertIntermediateHealth({ intermediateHf: peak, hfFloorWad, operation: "debt-swap" });

    const swappable = swappableAfterWithdraw(borrowAmount); // borrow is fee-charged too
    let rawQuote = 0n;
    if (quoter) {
      try {
        rawQuote = await quoteV3ExactInputSingle(client.publicClient, quoter, {
          tokenIn: toAddr,
          tokenOut: fromAddr,
          amountIn: swappable,
          fee,
        });
      } catch {
        rawQuote = 0n;
      }
    }
    assertPriceImpact({
      amountIn: swappable,
      quotedOut: rawQuote,
      priceInBase: toPrice,
      priceOutBase: fromPrice,
      decimalsIn: toRes.decimals,
      decimalsOut: fromRes.decimals,
      maxBps: controls.maxPriceImpactBps,
    });

    const quoteFloor = applySlippage(rawQuote, controls.slippageBps);
    const repayAmount = minBig(repayAmountForChunk(quoteFloor), pending);
    if (repayAmount === 0n) break;

    const executions: Execution[] = [
      ...buildBorrow(addrs.pool, client.walletAddress, toAddr, borrowAmount),
      ...client.buildSwapExactInputV3({
        tokenIn: toAddr,
        tokenOut: fromAddr,
        amountIn: swappable,
        amountOutMinimum: quoteFloor,
        fee,
        router,
      }),
      ...buildRepay(addrs.pool, client.walletAddress, fromAddr, repayAmount, repayAmount),
    ];

    const repaidBase = toBase(repayAmount, fromPrice, fromRes.decimals);
    state = { ...state, totalDebtBase: bigMax(state.totalDebtBase + chunkBase - repaidBase, 0n) };
    pending = bigMax(pending - repayAmount, 0n);
    toApprovals += swappable;
    fromApprovals += repayAmount;
    feeTo += borrowAmount - swappable;
    feeFrom += quoteFloor - repayAmount;

    chunks.push({
      description: `borrow ${fmtTo(borrowAmount)} → swap → repay ${fmtFrom(repayAmount)}`,
      executions,
      projectedHealthFactorAfter: healthFactorFromWeighted(weighted, state.totalDebtBase),
      projectedDebtAfter: pending,
      bvccFeeEstimates: [
        { token: toAddr, symbol: toRes.symbol ?? "", amount: borrowAmount - swappable },
        { token: fromAddr, symbol: fromRes.symbol ?? "", amount: quoteFloor - repayAmount },
      ],
    });
  }

  await assertPlanBudget(client, [
    [toAddr, toRes.symbol ?? "", toApprovals, toRes.decimals],
    [fromAddr, fromRes.symbol ?? "", fromApprovals, fromRes.decimals],
  ]);

  return {
    kind: "debtSwap",
    strategy: "chunked",
    chunks,
    requiredProtocols: [addrs.pool, router],
    requiredTokens: [fromAddr, toAddr],
    requiredBudgets: [
      { token: toAddr, symbol: toRes.symbol ?? "", amount: toApprovals },
      { token: fromAddr, symbol: fromRes.symbol ?? "", amount: fromApprovals },
    ],
    totalBvccFees: [
      { token: toAddr, symbol: toRes.symbol ?? "", amount: feeTo },
      { token: fromAddr, symbol: fromRes.symbol ?? "", amount: feeFrom },
    ],
    warnings,
    controls,
    summary: `${chunks.length} chunk(s) moving ${fmtFrom(target - pending)} of debt into ${toRes.symbol ?? ""}`.trim(),
  };
}

/** Shared budget check across a plan's total approvals. */
async function assertPlanBudget(
  client: BvccAgentClient,
  entries: readonly (readonly [Address, string, bigint, number])[],
): Promise<void> {
  const remaining = await client.getRemaining();
  for (const [token, symbol, required, decimals] of entries) {
    if (required === 0n) continue;
    const budget = remaining.tokens.find((t) => t.token.toLowerCase() === token.toLowerCase());
    assertBudget({
      token,
      symbol,
      required,
      remaining: budget ? budget.totalRemaining : null,
      fmt: (v) => `${formatUnits(v, decimals)} ${symbol}`.trim(),
    });
  }
}

/**
 * Run a plan chunk by chunk.
 *
 * Each chunk is re-derived from live state rather than replayed: prices move and
 * interest accrues between transactions, so planned calldata goes stale. Between
 * chunks the controls run again, the batch is simulated, and only then sent.
 */
export async function executePlan(
  client: BvccAgentClient,
  params: {
    kind: "repayWithCollateral" | "closePosition" | "collateralSwap" | "debtSwap";
    collateralAsset?: string;
    debtAsset?: string;
    fromAsset?: string;
    toAsset?: string;
    fromDebtAsset?: string;
    toDebtAsset?: string;
    amount?: string | "all";
    fee?: number;
  } & AavePlannerControls,
): Promise<AavePlanExecution> {
  const controls = resolveControls(params);
  const txHashes: `0x${string}`[] = [];
  let chunksCompleted = 0;
  let previousPending: bigint | null = null;
  let pending = 0n;

  /**
   * Re-planning from live state keeps the loop honest, but with an explicit
   * partial `amount` it would reset the target every round and move far more than
   * asked — observed on a fork: "migrate 800 USDC" migrated the whole 2000, because
   * each re-plan saw the original 800 as still outstanding. `"all"` is derived from
   * state and converges by itself; a fixed target has to be decremented by whatever
   * each chunk actually moved.
   */
  const fixedTarget = params.amount != null && params.amount !== "all";
  let remaining = fixedTarget ? Number(params.amount) : 0;

  try {
    for (let i = 0; i <= controls.maximumIterations; i++) {
      if (fixedTarget && remaining <= 0) break;
      const scoped = fixedTarget ? { ...params, amount: String(remaining) } : params;
      // Re-plan from scratch against current state.
      const plan =
        params.kind === "closePosition"
          ? await planClosePosition(client, params)
          : params.kind === "collateralSwap"
            ? await planCollateralSwap(client, {
                ...scoped,
                fromAsset: params.fromAsset!,
                toAsset: params.toAsset!,
              })
            : params.kind === "debtSwap"
              ? await planDebtSwap(client, {
                  ...scoped,
                  fromDebtAsset: params.fromDebtAsset!,
                  toDebtAsset: params.toDebtAsset!,
                })
              : await planRepayWithCollateral(client, {
                  ...scoped,
                  collateralAsset: params.collateralAsset!,
                  debtAsset: params.debtAsset!,
                });

      if (plan.chunks.length === 0) break;
      pending = plan.chunks[0].projectedDebtAfter;

      // Strict progress: refuse to spin while interest eats the reduction.
      if (previousPending != null) assertProgress(previousPending, pending, (v) => `${v}`);
      previousPending = pending;

      assertIterationsLeft(chunksCompleted, controls.maximumIterations, `${pending}`);

      const chunk = plan.chunks[0];
      const sim = await client.dryRun("aaveRepay", chunk.executions);
      if (!sim.ok) {
        return {
          ok: false,
          kind: params.kind,
          chunksCompleted,
          txHashes,
          pendingRemaining: pending,
          failure: {
            reason: "chunk-simulation-failed",
            message: sim.failure?.humanMessage ?? "The chunk failed simulation.",
            suggestedAction: sim.failure?.suggestedAction ?? "Inspect the position and controls.",
          },
        };
      }

      const res = await client.run("aaveRepay", chunk.executions);
      if (!res.ok) {
        return {
          ok: false,
          kind: params.kind,
          chunksCompleted,
          txHashes,
          pendingRemaining: pending,
          failure: {
            reason: "chunk-reverted",
            message: res.humanMessage,
            suggestedAction: res.suggestedAction,
          },
        };
      }
      txHashes.push(res.txHash);
      chunksCompleted++;
      if (fixedTarget) {
        // Subtract what this chunk moved so the next re-plan asks for less, not
        // for the original amount again.
        const planned = plan.chunks[0];
        const movedLabel = /([\d.]+)/.exec(planned.description);
        remaining -= movedLabel ? Number(movedLabel[1]) : remaining;
      }
      if (pending === 0n) break;
    }

    return { ok: true, kind: params.kind, chunksCompleted, txHashes, pendingRemaining: pending, failure: null };
  } catch (e) {
    if (e instanceof PlannerError) {
      return {
        ok: false,
        kind: params.kind,
        chunksCompleted,
        txHashes,
        pendingRemaining: pending,
        failure: {
          reason: e.abort.reason,
          message: e.abort.message,
          suggestedAction: e.abort.suggestedAction,
        },
      };
    }
    throw e;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
const bigMax = (a: bigint, b: bigint) => (a > b ? a : b);

function emptyPlan(kind: AavePlan["kind"], controls: ResolvedControls, summary: string): AavePlan {
  return {
    kind,
    strategy: "direct",
    chunks: [],
    requiredProtocols: [],
    requiredTokens: [],
    requiredBudgets: [],
    totalBvccFees: [],
    warnings: [],
    controls,
    summary,
  };
}
