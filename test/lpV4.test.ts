import { describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData, type Address, type Hex } from "viem";

import {
  buildMintV4,
  buildIncreaseV4,
  buildDecreaseV4,
  buildCollectV4,
  buildBurnV4,
  orderV4Currencies,
  poolId,
  NATIVE,
  type V4PoolKey,
} from "../src/lp/v4.js";
import { erc20Abi } from "../src/abi.js";
import { PERMIT2 } from "../src/universalRouter.js";

const PM: Address = "0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869";
const WALLET: Address = "0x605A4C65dBa64bd26d9F7701e1e4Cda48c594A5c";
const WETH: Address = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"; // < USDC
const USDC: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

const pmV4Abi = [
  {
    type: "function",
    name: "modifyLiquidities",
    stateMutability: "payable",
    inputs: [
      { name: "unlockData", type: "bytes" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const poolKeyComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

/** Decode a PM call into (actions bytes, params[]). */
function decodeModify(callData: Hex): { actions: number[]; params: readonly Hex[] } {
  const { args } = decodeFunctionData({ abi: pmV4Abi, data: callData });
  const [unlockData] = args as [Hex, bigint];
  const [actionsHex, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], unlockData) as [
    Hex,
    readonly Hex[],
  ];
  const bytes = actionsHex.slice(2);
  const actions: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) actions.push(parseInt(bytes.slice(i, i + 2), 16));
  return { actions, params };
}

const key = (hooks: Address = NATIVE): V4PoolKey => ({
  currency0: WETH,
  currency1: USDC,
  fee: 500,
  tickSpacing: 10,
  hooks,
});

describe("orderV4Currencies", () => {
  it("sorts by address and reports the flip", () => {
    const a = orderV4Currencies(USDC, WETH, 500, 10);
    expect(a.flipped).toBe(true);
    expect(a.key.currency0).toBe(WETH);
    expect(a.key.currency1).toBe(USDC);
  });

  it("native (zero) always sorts to currency0", () => {
    const a = orderV4Currencies(USDC, NATIVE, 500, 10);
    expect(a.key.currency0).toBe(NATIVE);
    expect(a.key.currency1).toBe(USDC);
  });
});

describe("poolId", () => {
  it("is deterministic keccak of the PoolKey", () => {
    expect(poolId(key())).toBe(poolId(key()));
    expect(poolId(key())).not.toBe(poolId(key("0x1111111111111111111111111111111111111111")));
  });
});

describe("buildMintV4 (ERC-20 / ERC-20)", () => {
  const ex = buildMintV4({
    positionManager: PM,
    key: key(),
    tickLower: -120,
    tickUpper: 120,
    liquidity: 1_000_000n,
    amount0Max: 5n,
    amount1Max: 9n,
    recipient: WALLET,
  });

  it("prepends Permit2 legs for BOTH tokens then the PM call", () => {
    // approve(WETH→Permit2), Permit2.approve(WETH→PM), approve(USDC→Permit2), Permit2.approve(USDC→PM), PM.modify
    expect(ex).toHaveLength(5);
    expect(ex[0].target).toBe(WETH);
    const a0 = decodeFunctionData({ abi: erc20Abi, data: ex[0].callData });
    expect(a0.functionName).toBe("approve");
    expect((a0.args as readonly unknown[])[0]).toBe(PERMIT2);
    expect(ex[1].target).toBe(PERMIT2);
    expect(ex[2].target).toBe(USDC);
    expect(ex[3].target).toBe(PERMIT2);
    expect(ex[4].target).toBe(PM);
    expect(ex[4].value).toBe(0n); // no native
  });

  it("mints to the wallet with MINT_POSITION + SETTLE_PAIR and the right pool/hook", () => {
    const { actions, params } = decodeModify(ex[4].callData);
    expect(actions).toEqual([0x02, 0x0d]); // MINT_POSITION, SETTLE_PAIR
    const [pk, , , , , , owner] = decodeAbiParameters(
      [
        { type: "tuple", components: poolKeyComponents },
        { type: "int24" },
        { type: "int24" },
        { type: "uint256" },
        { type: "uint128" },
        { type: "uint128" },
        { type: "address" },
        { type: "bytes" },
      ],
      params[0],
    ) as unknown as [V4PoolKey, number, number, bigint, bigint, bigint, Address, Hex];
    expect(owner).toBe(WALLET);
    expect(pk.hooks).toBe(NATIVE);
    expect(pk.currency0).toBe(WETH);
  });
});

describe("buildMintV4 (native ETH)", () => {
  it("sends value = amount0Max, no Permit2 for native, and SWEEPs dust to the wallet", () => {
    const { key: k } = orderV4Currencies(NATIVE, USDC, 500, 10); // native = currency0
    const ex = buildMintV4({
      positionManager: PM,
      key: k,
      tickLower: -120,
      tickUpper: 120,
      liquidity: 1_000_000n,
      amount0Max: 1_000n, // native
      amount1Max: 9n, // USDC
      recipient: WALLET,
    });
    // only USDC gets Permit2 legs (2) + PM call = 3
    expect(ex).toHaveLength(3);
    expect(ex[0].target).toBe(USDC);
    const pmCall = ex[ex.length - 1];
    expect(pmCall.target).toBe(PM);
    expect(pmCall.value).toBe(1_000n); // native funded by value
    const { actions, params } = decodeModify(pmCall.callData);
    expect(actions).toEqual([0x02, 0x0d, 0x14]); // MINT, SETTLE_PAIR, SWEEP
    const [currency, to] = decodeAbiParameters([{ type: "address" }, { type: "address" }], params[2]);
    expect(currency).toBe(NATIVE);
    expect(to).toBe(WALLET); // dust returns to wallet, never the PM
  });
});

describe("buildDecreaseV4 / collect / burn", () => {
  it("decrease → DECREASE + TAKE_PAIR with recipient = wallet", () => {
    const ex = buildDecreaseV4({
      positionManager: PM,
      tokenId: 42n,
      liquidity: 500n,
      amount0Min: 0n,
      amount1Min: 0n,
      currency0: WETH,
      currency1: USDC,
      recipient: WALLET,
    });
    expect(ex).toHaveLength(1);
    const { actions, params } = decodeModify(ex[0].callData);
    expect(actions).toEqual([0x01, 0x11]); // DECREASE, TAKE_PAIR
    const [, , recipient] = decodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }],
      params[1],
    );
    expect(recipient).toBe(WALLET);
  });

  it("collect = decrease with liquidity 0", () => {
    const ex = buildCollectV4({
      positionManager: PM,
      tokenId: 42n,
      currency0: WETH,
      currency1: USDC,
      recipient: WALLET,
    });
    const { actions, params } = decodeModify(ex[0].callData);
    expect(actions).toEqual([0x01, 0x11]);
    const [, liquidity] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
      params[0],
    ) as unknown as [bigint, bigint, bigint, bigint, Hex];
    expect(liquidity).toBe(0n);
  });

  it("burn → BURN_POSITION + TAKE_PAIR to wallet", () => {
    const ex = buildBurnV4({
      positionManager: PM,
      tokenId: 7n,
      amount0Min: 0n,
      amount1Min: 0n,
      currency0: WETH,
      currency1: USDC,
      recipient: WALLET,
    });
    const { actions, params } = decodeModify(ex[0].callData);
    expect(actions).toEqual([0x03, 0x11]); // BURN, TAKE_PAIR
    const [, , recipient] = decodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }],
      params[1],
    );
    expect(recipient).toBe(WALLET);
  });
});

describe("buildIncreaseV4", () => {
  it("INCREASE + SETTLE_PAIR, Permit2 legs for ERC-20", () => {
    const ex = buildIncreaseV4({
      positionManager: PM,
      key: key(),
      tokenId: 99n,
      liquidity: 1000n,
      amount0Max: 5n,
      amount1Max: 9n,
      recipient: WALLET,
    });
    const { actions } = decodeModify(ex[ex.length - 1].callData);
    expect(actions).toEqual([0x00, 0x0d]); // INCREASE_LIQUIDITY, SETTLE_PAIR
  });
});
