/**
 * Aave v3 — read side (Phase 1).
 *
 * Deterministic, read-only views an agent needs before touching a lending
 * position: account health, per-reserve positions, market parameters, and the
 * "how much can I safely move" calculators. No writes here, and nothing that
 * moves funds — the contract still enforces every limit.
 *
 * Prices are in the oracle's base currency (USD, 1e8 on Arbitrum). Rates come as
 * Aave RAY (1e27) per-second-ish APR figures and are converted to display APY.
 */
import { formatUnits, type Address, type PublicClient } from "viem";

import { resolveToken } from "../tokens.js";
import { aaveDataProviderAbi, aaveOracleAbi, aavePoolReadAbi, poolAddressesProviderAbi } from "./abi.js";
import { getAaveAddresses, type AaveAddresses } from "./addresses.js";

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;
/** Aave returns healthFactor as uint256.max when a user has no debt. */
const MAX_UINT = (1n << 256n) - 1n;

export interface AaveAccountData {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  availableBorrowsBase: bigint;
  currentLiquidationThreshold: bigint; // bps
  ltv: bigint; // bps
  healthFactor: bigint; // 1e18; MAX_UINT when no debt
  /** Human strings in USD (2 dp) and HF (or "∞" when no debt). */
  totalCollateralUsd: string;
  totalDebtUsd: string;
  availableBorrowsUsd: string;
  healthFactorFormatted: string;
  eModeCategoryId: number;
}

export interface AaveUserPosition {
  asset: Address;
  symbol: string | null;
  decimals: number;
  supplied: bigint;
  variableDebt: bigint;
  suppliedFormatted: string;
  variableDebtFormatted: string;
  suppliedUsd: string;
  debtUsd: string;
  usageAsCollateralEnabled: boolean;
  priceUsd: string;
  aTokenAddress: Address;
  variableDebtTokenAddress: Address;
}

export interface AaveReserveInfo {
  asset: Address;
  symbol: string | null;
  decimals: number;
  supplyApy: string; // percent, 2 dp
  variableBorrowApy: string; // percent, 2 dp
  ltvBps: number;
  liquidationThresholdBps: number;
  liquidationBonusBps: number;
  isActive: boolean;
  isFrozen: boolean;
  borrowingEnabled: boolean;
  usageAsCollateralEnabled: boolean;
  priceUsd: string;
  aTokenAddress: Address;
  variableDebtTokenAddress: Address;
  // ── Fields the planner's feasibility controls read ──────────────────────
  /** Paused reserves reject every operation, separately from `isActive`. */
  isPaused: boolean;
  /** Whole-token cap (0 = uncapped). A supply leg must fit under it. */
  supplyCap: bigint;
  /** Whole-token cap (0 = uncapped). A borrow leg must fit under it. */
  borrowCap: bigint;
  /** Non-zero = isolation mode; the reserve's debt ceiling. */
  debtCeiling: bigint;
  /** A siloed asset must be the user's only debt. */
  siloedBorrowing: boolean;
  /** Current totals, to measure headroom against the caps. */
  totalSupplied: bigint;
  totalVariableDebt: bigint;
}

/** Resolve + sanity-check the Aave deployment for a chain. Throws if unsupported. */
export async function resolveAave(
  publicClient: PublicClient,
  chainId: number,
): Promise<AaveAddresses> {
  const a = getAaveAddresses(chainId);
  if (!a) throw new Error(`Aave is not supported on chain ${chainId} in this SDK.`);
  // Guard against a stale hardcoded Pool: the provider is the source of truth.
  const livePool = (await publicClient.readContract({
    address: a.poolAddressesProvider,
    abi: poolAddressesProviderAbi,
    functionName: "getPool",
  })) as Address;
  if (livePool.toLowerCase() !== a.pool.toLowerCase()) {
    throw new Error(
      `Aave Pool mismatch on chain ${chainId}: provider reports ${livePool}, SDK has ${a.pool}. Update addresses.`,
    );
  }
  return a;
}

/** RAY per-second rate → display APY percentage string (compounded). */
function rayRateToApy(ratePerYearRay: bigint): string {
  // Aave's liquidityRate/variableBorrowRate are already annualized in RAY.
  const apr = Number(ratePerYearRay) / Number(RAY);
  const apy = (1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1;
  return (apy * 100).toFixed(2);
}

function usd(base: bigint, unit: bigint): string {
  // base currency has `unit` (1e8) decimals.
  return Number(formatUnits(base, Math.log10(Number(unit)))).toFixed(2);
}

/** Pool.getUserAccountData + eMode, with human-friendly USD/HF strings. */
export async function getAccountData(
  publicClient: PublicClient,
  chainId: number,
  user: Address,
): Promise<AaveAccountData> {
  const a = await resolveAave(publicClient, chainId);
  const [raw, eMode, unit] = await Promise.all([
    publicClient.readContract({
      address: a.pool,
      abi: aavePoolReadAbi,
      functionName: "getUserAccountData",
      args: [user],
    }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>,
    publicClient.readContract({
      address: a.pool,
      abi: aavePoolReadAbi,
      functionName: "getUserEMode",
      args: [user],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: a.oracle,
      abi: aaveOracleAbi,
      functionName: "BASE_CURRENCY_UNIT",
    }) as Promise<bigint>,
  ]);

  const [totalCollateralBase, totalDebtBase, availableBorrowsBase, clt, ltv, healthFactor] = raw;
  return {
    totalCollateralBase,
    totalDebtBase,
    availableBorrowsBase,
    currentLiquidationThreshold: clt,
    ltv,
    healthFactor,
    totalCollateralUsd: usd(totalCollateralBase, unit),
    totalDebtUsd: usd(totalDebtBase, unit),
    availableBorrowsUsd: usd(availableBorrowsBase, unit),
    healthFactorFormatted:
      healthFactor === MAX_UINT ? "∞" : Number(formatUnits(healthFactor, 18)).toFixed(2),
    eModeCategoryId: Number(eMode),
  };
}

/** Per-reserve position for the user: supplied aToken + variable debt, priced. */
export async function getUserPositions(
  publicClient: PublicClient,
  chainId: number,
  user: Address,
): Promise<AaveUserPosition[]> {
  const a = await resolveAave(publicClient, chainId);
  const reserves = (await publicClient.readContract({
    address: a.pool,
    abi: aavePoolReadAbi,
    functionName: "getReservesList",
  })) as Address[];

  const unit = (await publicClient.readContract({
    address: a.oracle,
    abi: aaveOracleAbi,
    functionName: "BASE_CURRENCY_UNIT",
  })) as bigint;

  const out: AaveUserPosition[] = [];
  for (const asset of reserves) {
    const [userData, tokens, price] = await Promise.all([
      publicClient.readContract({
        address: a.poolDataProvider,
        abi: aaveDataProviderAbi,
        functionName: "getUserReserveData",
        args: [asset, user],
      }) as Promise<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, number, boolean]>,
      publicClient.readContract({
        address: a.poolDataProvider,
        abi: aaveDataProviderAbi,
        functionName: "getReserveTokensAddresses",
        args: [asset],
      }) as Promise<readonly [Address, Address, Address]>,
      publicClient.readContract({
        address: a.oracle,
        abi: aaveOracleAbi,
        functionName: "getAssetPrice",
        args: [asset],
      }) as Promise<bigint>,
    ]);

    const supplied = userData[0];
    const variableDebt = userData[2];
    // Skip reserves the user has no exposure to — keeps the list actionable.
    if (supplied === 0n && variableDebt === 0n) continue;

    const info = resolveToken(chainId, asset);
    const decimals = info.decimals ?? 18;
    const priceUsdNum = Number(formatUnits(price, Math.log10(Number(unit))));
    const toUsd = (amt: bigint) => (Number(formatUnits(amt, decimals)) * priceUsdNum).toFixed(2);

    out.push({
      asset,
      symbol: info.symbol,
      decimals,
      supplied,
      variableDebt,
      suppliedFormatted: formatUnits(supplied, decimals),
      variableDebtFormatted: formatUnits(variableDebt, decimals),
      suppliedUsd: toUsd(supplied),
      debtUsd: toUsd(variableDebt),
      usageAsCollateralEnabled: userData[8],
      priceUsd: priceUsdNum.toFixed(2),
      aTokenAddress: tokens[0],
      variableDebtTokenAddress: tokens[2],
    });
  }
  return out;
}

/** Market parameters per reserve (rates, LTV/LT/bonus, flags, price). */
export async function getReserves(
  publicClient: PublicClient,
  chainId: number,
  assets?: (Address | string)[],
): Promise<AaveReserveInfo[]> {
  const a = await resolveAave(publicClient, chainId);
  const list = assets
    ? assets.map((x) => resolveToken(chainId, typeof x === "string" ? x : x).address)
    : ((await publicClient.readContract({
        address: a.pool,
        abi: aavePoolReadAbi,
        functionName: "getReservesList",
      })) as Address[]);

  const unit = (await publicClient.readContract({
    address: a.oracle,
    abi: aaveOracleAbi,
    functionName: "BASE_CURRENCY_UNIT",
  })) as bigint;

  const out: AaveReserveInfo[] = [];
  for (const asset of list) {
    const dp = (functionName: string) =>
      publicClient.readContract({
        address: a.poolDataProvider,
        abi: aaveDataProviderAbi,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        functionName: functionName as any,
        args: [asset],
      });
    const [cfg, data, tokens, price, caps, ceiling, siloed, paused] = await Promise.all([
      dp("getReserveConfigurationData") as Promise<
        readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean]
      >,
      dp("getReserveData") as Promise<readonly bigint[]>,
      dp("getReserveTokensAddresses") as Promise<readonly [Address, Address, Address]>,
      publicClient.readContract({
        address: a.oracle,
        abi: aaveOracleAbi,
        functionName: "getAssetPrice",
        args: [asset],
      }) as Promise<bigint>,
      dp("getReserveCaps") as Promise<readonly [bigint, bigint]>,
      dp("getDebtCeiling") as Promise<bigint>,
      dp("getSiloedBorrowing") as Promise<boolean>,
      dp("getPaused") as Promise<boolean>,
    ]);

    const info = resolveToken(chainId, asset);
    out.push({
      asset,
      symbol: info.symbol,
      decimals: Number(cfg[0]),
      supplyApy: rayRateToApy(data[5]), // liquidityRate
      variableBorrowApy: rayRateToApy(data[6]), // variableBorrowRate
      ltvBps: Number(cfg[1]),
      liquidationThresholdBps: Number(cfg[2]),
      liquidationBonusBps: Number(cfg[3]),
      usageAsCollateralEnabled: cfg[5],
      borrowingEnabled: cfg[6],
      isActive: cfg[8],
      isFrozen: cfg[9],
      priceUsd: Number(formatUnits(price, Math.log10(Number(unit)))).toFixed(2),
      aTokenAddress: tokens[0],
      variableDebtTokenAddress: tokens[2],
      isPaused: paused,
      borrowCap: caps[0],
      supplyCap: caps[1],
      debtCeiling: ceiling,
      siloedBorrowing: siloed,
      totalSupplied: data[2], // totalAToken
      totalVariableDebt: data[4],
    });
  }
  return out;
}

// ── Risk calculators (pure) ──────────────────────────────────────────────────
// HF = Σ(collateral_i × LT_i) / totalDebt. Aave keeps a single weighted LT in
// getUserAccountData (`currentLiquidationThreshold`), which lets us project moves
// without re-summing per reserve. Rounding is always conservative.

/** targetHF is 1e18-scaled (e.g. 1.6e18). All amounts in oracle base currency. */
export interface RiskInput {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  liquidationThresholdBps: bigint; // currentLiquidationThreshold
}

/**
 * Max additional debt (base currency) keeping HF ≥ targetHF.
 * maxSafeBorrow = Σ(coll×LT)/targetHF − totalDebt. Floored at 0.
 */
export function maxSafeBorrowBase(r: RiskInput, targetHF: bigint): bigint {
  const weighted = (r.totalCollateralBase * r.liquidationThresholdBps) / 10000n;
  const cap = (weighted * 10n ** 18n) / targetHF;
  return cap > r.totalDebtBase ? cap - r.totalDebtBase : 0n;
}

/**
 * Max collateral (base currency) that can be withdrawn keeping HF ≥ targetHF.
 * With one blended LT: withdrawable_weighted = Σ(coll×LT) − targetHF×debt, then
 * divide by LT to get gross collateral. Floored at 0.
 */
export function maxSafeWithdrawBase(r: RiskInput, targetHF: bigint): bigint {
  if (r.liquidationThresholdBps === 0n) return 0n;
  const weighted = (r.totalCollateralBase * r.liquidationThresholdBps) / 10000n;
  const need = (targetHF * r.totalDebtBase) / 10n ** 18n;
  if (weighted <= need) return 0n;
  return ((weighted - need) * 10000n) / r.liquidationThresholdBps;
}

/** Debt (base currency) to repay to reach targetHF. Ceiled. Floored at 0. */
export function repayToReachHFBase(r: RiskInput, targetHF: bigint): bigint {
  const weighted = (r.totalCollateralBase * r.liquidationThresholdBps) / 10000n;
  const keep = (weighted * 10n ** 18n) / targetHF;
  return r.totalDebtBase > keep ? r.totalDebtBase - keep : 0n;
}

/** No debt ⇒ Aave reports uint256.max. Exposed so callers can test for it. */
export const HF_INFINITE = MAX_UINT;

/**
 * Σ(collateral × liquidationThreshold) — the numerator of the health factor.
 *
 * `projectHealthFactor` assumes the blended threshold stays put, which is true
 * while you only add or remove one asset. A collateral SWAP breaks that: you drop
 * an asset with one threshold and add another with a different one, so the blend
 * itself moves. Working from the weighted sum sidesteps the problem entirely.
 */
export function weightedCollateralBase(r: RiskInput): bigint {
  return (r.totalCollateralBase * r.liquidationThresholdBps) / 10000n;
}

/** Health factor straight from a weighted-collateral sum and a debt figure. */
export function healthFactorFromWeighted(weightedBase: bigint, debtBase: bigint): bigint {
  if (debtBase <= 0n) return HF_INFINITE;
  if (weightedBase <= 0n) return 0n;
  return (weightedBase * 10n ** 18n) / debtBase;
}

/**
 * Health factor after moving collateral and/or debt, in base currency.
 *
 * This is what lets the planner size a chunk without sending it: propose a
 * withdrawal and a repayment, see where the HF lands, and only build the batch if
 * it stays above the floor. Uses the blended liquidation threshold Aave already
 * reports, so it matches `getUserAccountData().healthFactor` — verified against a
 * live position (collateral $19,996.5 / debt $5,709.4 / LT 78% → 2.732, identical
 * to what the Pool returned).
 *
 * Deltas are signed: negative withdraws collateral / repays debt.
 */
export function projectHealthFactor(
  r: RiskInput,
  deltas: { collateralBase?: bigint; debtBase?: bigint } = {},
): bigint {
  const coll = r.totalCollateralBase + (deltas.collateralBase ?? 0n);
  const debt = r.totalDebtBase + (deltas.debtBase ?? 0n);
  if (debt <= 0n) return HF_INFINITE;
  if (coll <= 0n) return 0n;
  const weighted = (coll * r.liquidationThresholdBps) / 10000n;
  return (weighted * 10n ** 18n) / debt;
}
