/**
 * Liquidity ranges in prices, and a sanity check on them.
 *
 * Ticks are easy to get wrong by hand: forgetting the decimals of the two tokens, or
 * flipping the sign of that correction, lands a WETH/USDC range around tick 78,000
 * or 355,000 while the pool trades near -199,000. Such a mint does not revert — it
 * opens an out-of-range position holding one token and earning nothing. These
 * helpers let callers give a range as prices and check any range against the pool.
 *
 * Price convention, everywhere here: how many `tokenA` one `tokenB` is worth — the
 * way a person reads it (for tokenA = USDC, tokenB = WETH: "2,500 USDC per WETH").
 */

const LOG_BASE = Math.log(1.0001);
const Q96 = 2 ** 96;

/** A price → its tick. `aIsToken0`: tokenA sorts first in the pool. */
export function priceToTick(price: number, decimalsA: number, decimalsB: number, aIsToken0: boolean): number {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error(`Invalid price: ${price}. Use a positive number.`);
  // The pool's raw price is token1 per token0, in base units.
  const raw = aIsToken0 ? (1 / price) * 10 ** (decimalsB - decimalsA) : price * 10 ** (decimalsA - decimalsB);
  return Math.floor(Math.log(raw) / LOG_BASE);
}

/** A tick → the price, in tokenA per tokenB. */
export function tickToPrice(tick: number, decimalsA: number, decimalsB: number, aIsToken0: boolean): number {
  const raw = Math.pow(1.0001, tick);
  return aIsToken0 ? 1 / (raw / 10 ** (decimalsB - decimalsA)) : raw / 10 ** (decimalsA - decimalsB);
}

/** The pool's current tick from its sqrtPriceX96. */
export function tickFromSqrtPrice(sqrtPriceX96: bigint): number {
  const ratio = Number(sqrtPriceX96) / Q96;
  return Math.floor(Math.log(ratio * ratio) / LOG_BASE);
}

/** Two prices → an ordered tick pair (a higher price can mean a lower tick). */
export function pricesToTicks(
  priceLower: number,
  priceUpper: number,
  decimalsA: number,
  decimalsB: number,
  aIsToken0: boolean,
): { tickLower: number; tickUpper: number } {
  const a = priceToTick(priceLower, decimalsA, decimalsB, aIsToken0);
  const b = priceToTick(priceUpper, decimalsA, decimalsB, aIsToken0);
  return { tickLower: Math.min(a, b), tickUpper: Math.max(a, b) };
}

export interface RangeInfo {
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  /** Prices in tokenA per tokenB, rounded for reading. */
  priceLower: string;
  priceUpper: string;
  priceCurrent: string;
  inRange: boolean;
  fullRange: boolean;
  warnings: string[];
}

/** How far a bound may sit from the current price before it earns a warning. */
export const FAR_FROM_PRICE = 0.5;

const fmt = (p: number) => (p >= 1 ? p.toPrecision(6) : p.toPrecision(4)).replace(/\.?0+(e|$)/, "$1");

/** Describe a range against the pool's current price, with plain warnings. */
export function describeRange(args: {
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  decimalsA: number;
  decimalsB: number;
  aIsToken0: boolean;
  symbolA: string;
  symbolB: string;
  fullRange: boolean;
}): RangeInfo {
  const { tickLower, tickUpper, currentTick, decimalsA, decimalsB, aIsToken0, symbolA, symbolB } = args;
  const pa = tickToPrice(tickLower, decimalsA, decimalsB, aIsToken0);
  const pb = tickToPrice(tickUpper, decimalsA, decimalsB, aIsToken0);
  const lo = Math.min(pa, pb);
  const hi = Math.max(pa, pb);
  const cur = tickToPrice(currentTick, decimalsA, decimalsB, aIsToken0);
  const inRange = currentTick >= tickLower && currentTick < tickUpper;
  const unit = `${symbolA} per ${symbolB}`;
  const warnings: string[] = [];
  if (!args.fullRange) {
    if (!inRange) {
      warnings.push(
        `The range ${fmt(lo)}–${fmt(hi)} ${unit} does not contain the current price (${fmt(cur)} ${unit}). ` +
          `The position would hold a single token and earn no fees until the price enters the range ` +
          `(fine for a limit-style position; if it is not what was meant, the range was probably computed without the tokens' decimals).`,
      );
    } else {
      if (lo < cur * (1 - FAR_FROM_PRICE))
        warnings.push(`The lower bound (${fmt(lo)} ${unit}) is more than 50% below the current price (${fmt(cur)}).`);
      if (hi > cur * (1 + FAR_FROM_PRICE))
        warnings.push(`The upper bound (${fmt(hi)} ${unit}) is more than 50% above the current price (${fmt(cur)}).`);
    }
  }
  return {
    tickLower,
    tickUpper,
    currentTick,
    priceLower: fmt(lo),
    priceUpper: fmt(hi),
    priceCurrent: fmt(cur),
    inRange,
    fullRange: args.fullRange,
    warnings,
  };
}
