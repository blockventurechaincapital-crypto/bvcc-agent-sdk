/**
 * Uniswap v4 liquidity (PositionManager `modifyLiquidities`) builders.
 *
 * v4 encodes a batch of actions inside one call:
 *   modifyLiquidities(bytes unlockData, uint256 deadline)
 *   unlockData = abi.encode(bytes actions, bytes[] params)   // one byte per action
 *
 * These build the exact action sequences the on-chain BVCCPositionManagerValidator
 * accepts: MINT/INCREASE fund the position from the wallet (SETTLE_PAIR, ERC-20 via
 * Permit2 or native via msg.value); DECREASE/COLLECT/BURN pay proceeds out with
 * TAKE_PAIR whose recipient is ALWAYS the wallet. Native pools use
 * `currency0 = address(0)` and a trailing SWEEP that returns leftover ETH dust to
 * the wallet — never to the PositionManager (which would be sweepable by anyone).
 *
 * v4 LP fails closed until the PositionManager's DEEP validator is active in the
 * registry (48h governance) and the wallet owner has set the DEEP policy on
 * (PositionManager, modifyLiquidities) with Face ID.
 */
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { erc20Abi } from "./../abi.js";
import { PERMIT2 } from "./../universalRouter.js";
import type { Execution } from "./../types.js";

// v4 Actions (one byte each; v4 dispatches without masking).
const MINT_POSITION = 0x02;
const INCREASE_LIQUIDITY = 0x00;
const DECREASE_LIQUIDITY = 0x01;
const BURN_POSITION = 0x03;
const SETTLE_PAIR = 0x0d;
const TAKE_PAIR = 0x11;
const SWEEP = 0x14;

/** Native currency in a v4 PoolKey. */
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";
const MAX_UINT48 = (1n << 48n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;

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

const permit2Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
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

export interface V4PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/**
 * Sort a currency pair for a v4 PoolKey (currency0 < currency1; native = the zero
 * address always sorts first). Returns the key plus which side each input maps to.
 */
export function orderV4Currencies(
  a: Address,
  b: Address,
  fee: number,
  tickSpacing: number,
  hooks: Address = NATIVE,
): { key: V4PoolKey; flipped: boolean } {
  const flipped = a.toLowerCase() > b.toLowerCase();
  const [currency0, currency1] = flipped ? [b, a] : [a, b];
  return { key: { currency0, currency1, fee, tickSpacing, hooks }, flipped };
}

/** Deterministic v4 pool id = keccak256(abi.encode(PoolKey)). */
export function poolId(key: V4PoolKey): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "tuple", components: poolKeyComponents }], [key]),
  );
}

function packActions(actions: number[]): Hex {
  return concatHex(actions.map((a) => (("0x" + a.toString(16).padStart(2, "0")) as Hex)));
}

function encodeModify(actions: number[], params: Hex[], deadline: bigint): Hex {
  const unlockData = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [packActions(actions), params],
  );
  return encodeFunctionData({ abi: pmV4Abi, functionName: "modifyLiquidities", args: [unlockData, deadline] });
}

const mintParamsAbi = [
  { type: "tuple", components: poolKeyComponents },
  { type: "int24" },
  { type: "int24" },
  { type: "uint256" },
  { type: "uint128" },
  { type: "uint128" },
  { type: "address" },
  { type: "bytes" },
] as const;

function isNative(c: Address): boolean {
  return c.toLowerCase() === NATIVE;
}

function deadlineOrDefault(d?: bigint): bigint {
  return d ?? BigInt(Math.floor(Date.now() / 1000) + 1200);
}

/** Permit2 funding legs for a non-native currency: approve(Permit2) + Permit2.approve(PM). */
function permit2Legs(token: Address, pm: Address, amount: bigint, expiration: bigint): Execution[] {
  if (amount === 0n || isNative(token)) return [];
  if (amount > MAX_UINT160) throw new Error("amount exceeds uint160 (Permit2 limit)");
  return [
    {
      target: token,
      value: 0n,
      callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PERMIT2, amount] }),
    },
    {
      target: PERMIT2,
      value: 0n,
      callData: encodeFunctionData({
        abi: permit2Abi,
        functionName: "approve",
        args: [token, pm, amount, Number(expiration > MAX_UINT48 ? MAX_UINT48 : expiration)],
      }),
    },
  ];
}

export interface MintV4Params {
  positionManager: Address;
  key: V4PoolKey; // currency0 < currency1 (use orderV4Currencies)
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  /** Position owner / proceeds — pinned to the wallet by the validator. */
  recipient: Address;
  hookData?: Hex;
  deadline?: bigint;
}

/**
 * Open a v4 position. Funds the pair via SETTLE_PAIR: ERC-20 sides through Permit2,
 * a native side (currency0 == 0) through `value` on the PM call, with a trailing
 * SWEEP returning native dust to the wallet.
 */
export function buildMintV4(p: MintV4Params): Execution[] {
  const dl = deadlineOrDefault(p.deadline);
  const executions: Execution[] = [];
  executions.push(...permit2Legs(p.key.currency0, p.positionManager, p.amount0Max, dl));
  executions.push(...permit2Legs(p.key.currency1, p.positionManager, p.amount1Max, dl));

  const nativeSide = isNative(p.key.currency0); // native, if any, is always currency0
  const actions = [MINT_POSITION, SETTLE_PAIR];
  const params: Hex[] = [
    encodeAbiParameters(mintParamsAbi, [
      p.key,
      p.tickLower,
      p.tickUpper,
      p.liquidity,
      p.amount0Max,
      p.amount1Max,
      p.recipient,
      p.hookData ?? "0x",
    ]),
    encodeAbiParameters([{ type: "address" }, { type: "address" }], [p.key.currency0, p.key.currency1]),
  ];
  if (nativeSide) {
    // Return any unused native to the wallet (never leave it in the PM).
    actions.push(SWEEP);
    params.push(encodeAbiParameters([{ type: "address" }, { type: "address" }], [NATIVE, p.recipient]));
  }

  executions.push({
    target: p.positionManager,
    value: nativeSide ? p.amount0Max : 0n,
    callData: encodeModify(actions, params, dl),
  });
  return executions;
}

export interface IncreaseV4Params extends Omit<MintV4Params, "tickLower" | "tickUpper"> {
  tokenId: bigint;
}

/** Add liquidity to an existing v4 position (owner-gated on-chain). */
export function buildIncreaseV4(p: IncreaseV4Params): Execution[] {
  const dl = deadlineOrDefault(p.deadline);
  const executions: Execution[] = [];
  executions.push(...permit2Legs(p.key.currency0, p.positionManager, p.amount0Max, dl));
  executions.push(...permit2Legs(p.key.currency1, p.positionManager, p.amount1Max, dl));

  const nativeSide = isNative(p.key.currency0);
  const actions = [INCREASE_LIQUIDITY, SETTLE_PAIR];
  const params: Hex[] = [
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
      [p.tokenId, p.liquidity, p.amount0Max, p.amount1Max, p.hookData ?? "0x"],
    ),
    encodeAbiParameters([{ type: "address" }, { type: "address" }], [p.key.currency0, p.key.currency1]),
  ];
  if (nativeSide) {
    actions.push(SWEEP);
    params.push(encodeAbiParameters([{ type: "address" }, { type: "address" }], [NATIVE, p.recipient]));
  }

  executions.push({
    target: p.positionManager,
    value: nativeSide ? p.amount0Max : 0n,
    callData: encodeModify(actions, params, dl),
  });
  return executions;
}

export interface DecreaseV4Params {
  positionManager: Address;
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  currency0: Address;
  currency1: Address;
  /** Where proceeds go — pinned to the wallet by the validator. */
  recipient: Address;
  hookData?: Hex;
  deadline?: bigint;
}

/** Remove liquidity (or collect fees with liquidity = 0): DECREASE + TAKE_PAIR to wallet. */
export function buildDecreaseV4(p: DecreaseV4Params): Execution[] {
  const dl = deadlineOrDefault(p.deadline);
  const callData = encodeModify(
    [DECREASE_LIQUIDITY, TAKE_PAIR],
    [
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
        [p.tokenId, p.liquidity, p.amount0Min, p.amount1Min, p.hookData ?? "0x"],
      ),
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }],
        [p.currency0, p.currency1, p.recipient],
      ),
    ],
    dl,
  );
  return [{ target: p.positionManager, value: 0n, callData }];
}

/** Collect owed fees to the wallet (DECREASE with liquidity 0 + TAKE_PAIR). */
export function buildCollectV4(p: Omit<DecreaseV4Params, "liquidity" | "amount0Min" | "amount1Min">): Execution[] {
  return buildDecreaseV4({ ...p, liquidity: 0n, amount0Min: 0n, amount1Min: 0n });
}

export interface BurnV4Params {
  positionManager: Address;
  tokenId: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  currency0: Address;
  currency1: Address;
  recipient: Address;
  hookData?: Hex;
  deadline?: bigint;
}

/** Burn a position (removes remaining liquidity + burns) and take proceeds to wallet. */
export function buildBurnV4(p: BurnV4Params): Execution[] {
  const dl = deadlineOrDefault(p.deadline);
  const callData = encodeModify(
    [BURN_POSITION, TAKE_PAIR],
    [
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
        [p.tokenId, p.amount0Min, p.amount1Min, p.hookData ?? "0x"],
      ),
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }],
        [p.currency0, p.currency1, p.recipient],
      ),
    ],
    dl,
  );
  return [{ target: p.positionManager, value: 0n, callData }];
}
