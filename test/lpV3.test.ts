import { describe, expect, it } from "vitest";
import { decodeFunctionData, toFunctionSelector, type Hex } from "viem";

import {
  buildMintV3,
  buildDecreaseV3,
  buildCollectV3,
  buildBurnV3,
  orderV3Tokens,
} from "../src/lp/v3.js";
import {
  feeToTickSpacing,
  fullRangeTicks,
  nearestUsableTick,
  getSqrtRatioAtTick,
  amountsForLiquidity,
  getLiquidityForAmounts,
  MIN_TICK,
  MAX_TICK,
} from "../src/lp/tickMath.js";
import { BvccAgentClient } from "../src/client.js";
import { erc20Abi, nfpmAbi } from "../src/abi.js";

const NFPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88" as const;
const WALLET = "0x605A4C65dBa64bd26d9F7701e1e4Cda48c594A5c" as const;
// WETH < USDC by address, so token0=WETH, token1=USDC after sorting.
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as const;
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
// A throwaway agent key — only used to derive an address; never funded.
const AGENT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

/** Which 32-byte words (0-indexed, after the selector) equal `addr`. */
function wordsOf(calldata: string, addr: string): number[] {
  const body = calldata.slice(10);
  const target = addr.slice(2).toLowerCase().padStart(64, "0");
  const out: number[] = [];
  for (let i = 0; i * 64 < body.length; i++) {
    if (body.slice(i * 64, (i + 1) * 64).toLowerCase() === target) out.push(i);
  }
  return out;
}

const sel = (cd: Hex) => cd.slice(0, 10).toLowerCase();

describe("orderV3Tokens", () => {
  it("keeps order when tokenA < tokenB and carries amounts", () => {
    const o = orderV3Tokens(WETH, 10n, USDC, 20n);
    expect(o.flipped).toBe(false);
    expect(o.token0).toBe(WETH);
    expect(o.amount0).toBe(10n);
    expect(o.token1).toBe(USDC);
    expect(o.amount1).toBe(20n);
  });

  it("flips when tokenA > tokenB, keeping each amount with its token", () => {
    const o = orderV3Tokens(USDC, 20n, WETH, 10n);
    expect(o.flipped).toBe(true);
    expect(o.token0).toBe(WETH);
    expect(o.amount0).toBe(10n);
    expect(o.token1).toBe(USDC);
    expect(o.amount1).toBe(20n);
  });
});

describe("buildMintV3", () => {
  const base = {
    nfpm: NFPM,
    token0: WETH,
    token1: USDC,
    fee: 3000,
    tickLower: -60,
    tickUpper: 60,
    amount0Desired: 1000n,
    amount1Desired: 2000n,
    amount0Min: 990n,
    amount1Min: 1980n,
    recipient: WALLET,
  };

  it("approves BOTH tokens to the NFPM, then mints", () => {
    const ex = buildMintV3(base);
    expect(ex).toHaveLength(3);
    // approve token0 → NFPM
    expect(ex[0].target).toBe(WETH);
    const a0 = decodeFunctionData({ abi: erc20Abi, data: ex[0].callData });
    expect(a0.functionName).toBe("approve");
    expect((a0.args as readonly unknown[])[0]).toBe(NFPM);
    expect((a0.args as readonly unknown[])[1]).toBe(1000n);
    // approve token1 → NFPM
    expect(ex[1].target).toBe(USDC);
    const a1 = decodeFunctionData({ abi: erc20Abi, data: ex[1].callData });
    expect((a1.args as readonly unknown[])[0]).toBe(NFPM);
    expect((a1.args as readonly unknown[])[1]).toBe(2000n);
  });

  it("mints to the wallet (selector 0x88316456, recipient at word 9)", () => {
    const ex = buildMintV3(base);
    const mint = ex[2];
    expect(mint.target).toBe(NFPM);
    expect(mint.value).toBe(0n);
    expect(sel(mint.callData)).toBe(toFunctionSelector(
      "mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))",
    ));
    // recipient must land exactly on word 9 (what the on-chain policy pins).
    expect(wordsOf(mint.callData, WALLET)).toEqual([9]);
    // token0/token1 at words 0/1 (the fee snapshot won't see them anyway — mint has no fee).
    expect(wordsOf(mint.callData, WETH)).toEqual([0]);
    expect(wordsOf(mint.callData, USDC)).toEqual([1]);
  });

  it("skips the approve for a zero-amount (single-sided) leg", () => {
    const ex = buildMintV3({ ...base, amount1Desired: 0n });
    expect(ex).toHaveLength(2);
    expect(ex[0].target).toBe(WETH);
    expect(sel(ex[1].callData)).toBe(sel(buildMintV3(base)[2].callData));
  });

  it("rejects unsorted tokens", () => {
    expect(() => buildMintV3({ ...base, token0: USDC, token1: WETH })).toThrow(/token0 must be < token1/);
  });
});

describe("buildCollectV3", () => {
  it("collects to the wallet (selector 0xfc6f7865, recipient at word 1)", () => {
    const ex = buildCollectV3({ nfpm: NFPM, tokenId: 12345n, recipient: WALLET });
    expect(ex).toHaveLength(1);
    expect(ex[0].target).toBe(NFPM);
    expect(sel(ex[0].callData)).toBe(toFunctionSelector("collect((uint256,address,uint128,uint128))"));
    expect(wordsOf(ex[0].callData, WALLET)).toEqual([1]);
    // amount0Max/amount1Max default to type(uint128).max
    const d = decodeFunctionData({ abi: nfpmAbi, data: ex[0].callData });
    const p = (d.args as readonly Record<string, bigint>[])[0];
    expect(p.amount0Max).toBe((1n << 128n) - 1n);
    expect(p.amount1Max).toBe((1n << 128n) - 1n);
  });
});

describe("buildDecreaseV3", () => {
  it("decreases then collects to the wallet", () => {
    const ex = buildDecreaseV3({
      nfpm: NFPM,
      tokenId: 7n,
      liquidity: 500n,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: WALLET,
    });
    expect(ex).toHaveLength(2);
    expect(sel(ex[0].callData)).toBe(
      toFunctionSelector("decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))"),
    );
    // second call is the collect, recipient = wallet at word 1
    expect(sel(ex[1].callData)).toBe(toFunctionSelector("collect((uint256,address,uint128,uint128))"));
    expect(wordsOf(ex[1].callData, WALLET)).toEqual([1]);
  });
});

describe("buildBurnV3", () => {
  it("burns a tokenId (selector 0x42966c68)", () => {
    const ex = buildBurnV3(NFPM, 42n);
    expect(ex).toHaveLength(1);
    expect(sel(ex[0].callData)).toBe(toFunctionSelector("burn(uint256)"));
    const d = decodeFunctionData({ abi: nfpmAbi, data: ex[0].callData });
    expect((d.args as readonly bigint[])[0]).toBe(42n);
  });
});

describe("tickMath range helpers", () => {
  it("maps fee tiers to spacings", () => {
    expect(feeToTickSpacing(100)).toBe(1);
    expect(feeToTickSpacing(500)).toBe(10);
    expect(feeToTickSpacing(3000)).toBe(60);
    expect(feeToTickSpacing(10000)).toBe(200);
    expect(() => feeToTickSpacing(1234)).toThrow();
  });

  it("full-range ticks are spacing-aligned and inside bounds", () => {
    const { tickLower, tickUpper } = fullRangeTicks(3000);
    expect(tickLower % 60 === 0).toBe(true);
    expect(tickUpper % 60 === 0).toBe(true);
    expect(tickLower).toBeGreaterThanOrEqual(MIN_TICK);
    expect(tickUpper).toBeLessThanOrEqual(MAX_TICK);
    expect(tickLower).toBeLessThan(tickUpper);
  });

  it("nearestUsableTick aligns to spacing", () => {
    expect(nearestUsableTick(61, 60)).toBe(60);
    expect(nearestUsableTick(89, 60)).toBe(60);
    expect(nearestUsableTick(90, 60)).toBe(120);
  });

  it("sizes a full-range mint to the pool ratio (real Arbitrum WETH/USDC price)", () => {
    // slot0.sqrtPriceX96 observed on the 0.05% WETH/USDC pool (~$1856/ETH),
    // token0=WETH(18d), token1=USDC(6d).
    const sqrtP = 3413768644403103596855686n;
    const { tickLower, tickUpper } = fullRangeTicks(500);
    const sqrtA = getSqrtRatioAtTick(tickLower);
    const sqrtB = getSqrtRatioAtTick(tickUpper);
    const amount0Max = 100000000000000n; // 0.0001 WETH
    const amount1Max = 500000n; // 0.5 USDC (deliberately oversupplied)

    const L = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0Max, amount1Max);
    const { amount0, amount1 } = amountsForLiquidity(sqrtP, tickLower, tickUpper, L);

    // Never asks for more than the maxes.
    expect(amount0).toBeLessThanOrEqual(amount0Max);
    expect(amount1).toBeLessThanOrEqual(amount1Max);
    // WETH is the binding side (near-fully used); USDC is only partly used (~0.185).
    expect(amount0).toBeGreaterThan((amount0Max * 99n) / 100n);
    expect(amount1).toBeLessThan(amount1Max);
    expect(amount1).toBeGreaterThan(150000n); // ~0.185 USDC, not near 0.5
  });
});

describe("client.buildAddLiquidityV3 (pure, no I/O)", () => {
  const client = new BvccAgentClient({ network: 42161, account: AGENT_KEY, walletAddress: WALLET });

  it("orders tokens, defaults to full-range, mints to the wallet", () => {
    // Pass tokens in the "wrong" order to prove the client sorts them.
    const ex = client.buildAddLiquidityV3({
      tokenA: USDC,
      amountA: 2000n,
      tokenB: WETH,
      amountB: 1n,
      fee: 3000,
    });
    const mint = ex[ex.length - 1];
    const d = decodeFunctionData({ abi: nfpmAbi, data: mint.callData });
    const p = d.args[0] as {
      token0: string;
      token1: string;
      recipient: string;
      tickLower: number;
      tickUpper: number;
      amount0Desired: bigint;
      amount1Desired: bigint;
    };
    expect(p.token0).toBe(WETH); // sorted
    expect(p.token1).toBe(USDC);
    expect(p.amount0Desired).toBe(1n); // WETH amount followed its token
    expect(p.amount1Desired).toBe(2000n);
    expect(p.recipient).toBe(WALLET);
    // full-range default for fee 3000
    expect(p.tickLower).toBe(fullRangeTicks(3000).tickLower);
    expect(p.tickUpper).toBe(fullRangeTicks(3000).tickUpper);
  });

  it("derives amount minimums from slippageBps against the right token", () => {
    const ex = client.buildAddLiquidityV3({
      tokenA: WETH,
      amountA: 1000n,
      tokenB: USDC,
      amountB: 2000n,
      fee: 3000,
      slippageBps: 100, // 1%
    });
    const mint = ex[ex.length - 1];
    const p = (decodeFunctionData({ abi: nfpmAbi, data: mint.callData }).args as readonly Record<string, bigint>[])[0];
    expect(p.amount0Min).toBe(990n); // 1000 - 1%
    expect(p.amount1Min).toBe(1980n); // 2000 - 1%
  });
});
