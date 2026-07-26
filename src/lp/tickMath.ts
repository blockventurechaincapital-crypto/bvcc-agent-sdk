/**
 * Minimal TickMath / LiquidityAmounts port for the v3 LP helpers.
 *
 * Ported from the BVCC frontend (`bvcc_wallet/lib/tickMath.ts`) and extended with
 * the range helpers a mint needs (fee → tickSpacing, full-range bounds, tick
 * alignment). Pure functions, no I/O.
 */

const Q96 = 2n ** 96n;
const MAX_UINT256 = 2n ** 256n - 1n;

/** Uniswap v3 tick bounds. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/**
 * Standard Uniswap v3 fee tier → tick spacing. A pool's spacing is fixed by its
 * fee; a mint's ticks MUST be multiples of it or the NFPM reverts.
 */
export function feeToTickSpacing(fee: number): number {
  switch (fee) {
    case 100:
      return 1;
    case 500:
      return 10;
    case 3000:
      return 60;
    case 10000:
      return 200;
    default:
      throw new Error(
        `Unknown v3 fee tier ${fee}. Known tiers: 100, 500, 3000, 10000. ` +
          `Pass tickLower/tickUpper explicitly for a non-standard pool.`,
      );
  }
}

/** Round a tick DOWN to the nearest multiple of `spacing` (toward -∞). */
export function alignTickDown(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}

/** Round a tick UP to the nearest multiple of `spacing` (toward +∞). */
export function alignTickUp(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

/** Nearest usable (spacing-aligned) tick, clamped to [MIN_TICK, MAX_TICK]. */
export function nearestUsableTick(tick: number, spacing: number): number {
  const rounded = Math.round(tick / spacing) * spacing;
  if (rounded < MIN_TICK) return alignTickUp(MIN_TICK, spacing);
  if (rounded > MAX_TICK) return alignTickDown(MAX_TICK, spacing);
  return rounded;
}

/** The widest spacing-aligned range: a full-range position for this fee tier. */
export function fullRangeTicks(fee: number): { tickLower: number; tickUpper: number } {
  const spacing = feeToTickSpacing(fee);
  return { tickLower: alignTickUp(MIN_TICK, spacing), tickUpper: alignTickDown(MAX_TICK, spacing) };
}

/** sqrtPriceX96 at a tick. Port of TickMath.getSqrtRatioAtTick. */
export function getSqrtRatioAtTick(tick: number): bigint {
  const absTick = BigInt(Math.abs(tick));
  let ratio =
    (absTick & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const muls: [bigint, bigint][] = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, m] of muls) if ((absTick & bit) !== 0n) ratio = (ratio * m) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Q128.128 → Q96 (sqrtPriceX96), round up.
  return (ratio >> 32n) + ((ratio & ((1n << 32n) - 1n)) === 0n ? 0n : 1n);
}

/** How much token0 and token1 a liquidity L represents at a given price/range. */
export function amountsForLiquidity(
  sqrtP: bigint,
  tickLower: number,
  tickUpper: number,
  L: bigint,
): { amount0: bigint; amount1: bigint } {
  let sa = getSqrtRatioAtTick(tickLower);
  let sb = getSqrtRatioAtTick(tickUpper);
  if (sa > sb) [sa, sb] = [sb, sa];
  let amount0 = 0n;
  let amount1 = 0n;
  if (sqrtP <= sa) {
    amount0 = ((L << 96n) * (sb - sa)) / sb / sa; // below range → all token0
  } else if (sqrtP < sb) {
    amount0 = ((L << 96n) * (sb - sqrtP)) / sb / sqrtP;
    amount1 = (L * (sqrtP - sa)) / Q96;
  } else {
    amount1 = (L * (sb - sa)) / Q96; // above range → all token1
  }
  return { amount0, amount1 };
}

/** Apply slippage (bps) as a downward floor: `amount * (1 - bps/10000)`. */
export function minusSlippage(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (amount * (10_000n - bps)) / 10_000n;
}

// --- LiquidityAmounts (Uniswap v3-periphery) -------------------------------
// Port of the canonical library so the SDK can size a mint from the pool's
// current price, instead of guessing the token ratio. `L` is liquidity units.

/** Liquidity that `amount0` provides across [sqrtA, sqrtB]. */
export function getLiquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const intermediate = (sqrtA * sqrtB) / Q96;
  return (amount0 * intermediate) / (sqrtB - sqrtA);
}

/** Liquidity that `amount1` provides across [sqrtA, sqrtB]. */
export function getLiquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (amount1 * Q96) / (sqrtB - sqrtA);
}

/**
 * Max liquidity obtainable from having `amount0` of token0 AND `amount1` of
 * token1, at the current price `sqrtP` and range [sqrtA, sqrtB]. When the price
 * is inside the range, the binding side wins (min of the two), which is exactly
 * what the NFPM computes — so sizing a mint from this L never over-asks either
 * token and the amount minimums hold.
 */
export function getLiquidityForAmounts(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtP <= sqrtA) return getLiquidityForAmount0(sqrtA, sqrtB, amount0);
  if (sqrtP < sqrtB) {
    const l0 = getLiquidityForAmount0(sqrtP, sqrtB, amount0);
    const l1 = getLiquidityForAmount1(sqrtA, sqrtP, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return getLiquidityForAmount1(sqrtA, sqrtB, amount1);
}
