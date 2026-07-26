/**
 * Uniswap v3 liquidity (NonfungiblePositionManager) builders.
 *
 * Each returns an `Execution[]` batch for `BvccAgentClient.execute(...)`. The
 * recipient of every mint/collect is the wallet — the on-chain call policy pins
 * it (mint word 9, collect word 1), so a wrong recipient reverts rather than
 * losing funds.
 *
 * There is deliberately NO `increaseLiquidity` builder: unlike decrease/collect/
 * burn the NFPM does not gate it to the position owner, so exposing it to an
 * agent would be a recipient-whitelist bypass (pull the wallet's approved tokens
 * into an attacker-owned tokenId). To add liquidity the agent mints a fresh
 * position instead.
 *
 * Fee note: `mint` lowers the wallet's balance → no BVCC fee. `collect` and the
 * sweep after `decreaseLiquidity` raise it, but v3 collect calldata carries no
 * token address, so the wallet's Case-3 fee snapshot finds nothing and charges
 * no fee on v3 withdrawals (same as the owner's frontend claim today). v4 LP does
 * charge it.
 */
import { encodeFunctionData, type Address } from "viem";
import { erc20Abi, nfpmAbi } from "../abi.js";
import type { Execution } from "../types.js";

const DEFAULT_DEADLINE_SECS = 1200;
/** collect(amount0Max/amount1Max) sentinel meaning "everything owed". */
export const MAX_UINT128 = (1n << 128n) - 1n;

function deadlineOrDefault(d?: bigint): bigint {
  return d ?? BigInt(Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECS);
}

/**
 * Uniswap requires `token0 < token1` (address order). Order a user's (tokenA,
 * tokenB) pair and carry their amounts alongside so callers keep amounts aligned
 * with the sorted tokens. `flipped` is true when the inputs were swapped.
 */
export function orderV3Tokens(
  tokenA: Address,
  amountA: bigint,
  tokenB: Address,
  amountB: bigint,
): { token0: Address; token1: Address; amount0: bigint; amount1: bigint; flipped: boolean } {
  const flipped = tokenA.toLowerCase() > tokenB.toLowerCase();
  return flipped
    ? { token0: tokenB, token1: tokenA, amount0: amountB, amount1: amountA, flipped }
    : { token0: tokenA, token1: tokenB, amount0: amountA, amount1: amountB, flipped };
}

export interface MintV3Params {
  nfpm: Address;
  /** Must be address-sorted: token0 < token1. Use `orderV3Tokens` first. */
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  /** Position owner. Pinned to the wallet by policy (calldata word 9). */
  recipient: Address;
  deadline?: bigint;
}

/**
 * Open a new v3 position: approve whichever tokens have a non-zero desired amount
 * to the NFPM, then `mint`. Both approves count toward the agent's token budget.
 */
export function buildMintV3(p: MintV3Params): Execution[] {
  if (p.token0.toLowerCase() >= p.token1.toLowerCase()) {
    throw new Error("buildMintV3: token0 must be < token1 (address order). Use orderV3Tokens.");
  }
  const executions: Execution[] = [];
  if (p.amount0Desired > 0n) {
    executions.push(approveTo(p.token0, p.nfpm, p.amount0Desired));
  }
  if (p.amount1Desired > 0n) {
    executions.push(approveTo(p.token1, p.nfpm, p.amount1Desired));
  }
  executions.push({
    target: p.nfpm,
    value: 0n,
    callData: encodeFunctionData({
      abi: nfpmAbi,
      functionName: "mint",
      args: [
        {
          token0: p.token0,
          token1: p.token1,
          fee: p.fee,
          tickLower: p.tickLower,
          tickUpper: p.tickUpper,
          amount0Desired: p.amount0Desired,
          amount1Desired: p.amount1Desired,
          amount0Min: p.amount0Min,
          amount1Min: p.amount1Min,
          recipient: p.recipient,
          deadline: deadlineOrDefault(p.deadline),
        },
      ],
    }),
  });
  return executions;
}

export interface DecreaseV3Params {
  nfpm: Address;
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  /** Where the withdrawn tokens land. Pinned to the wallet (collect word 1). */
  recipient: Address;
  deadline?: bigint;
}

/**
 * Remove liquidity: `decreaseLiquidity` credits the freed tokens (plus any owed
 * fees) to the position, then `collect` sweeps them to the wallet in one batch.
 */
export function buildDecreaseV3(p: DecreaseV3Params): Execution[] {
  return [
    {
      target: p.nfpm,
      value: 0n,
      callData: encodeFunctionData({
        abi: nfpmAbi,
        functionName: "decreaseLiquidity",
        args: [
          {
            tokenId: p.tokenId,
            liquidity: p.liquidity,
            amount0Min: p.amount0Min,
            amount1Min: p.amount1Min,
            deadline: deadlineOrDefault(p.deadline),
          },
        ],
      }),
    },
    buildCollectV3({ nfpm: p.nfpm, tokenId: p.tokenId, recipient: p.recipient })[0],
  ];
}

export interface CollectV3Params {
  nfpm: Address;
  tokenId: bigint;
  /** Where fees go. Pinned to the wallet by policy (calldata word 1). */
  recipient: Address;
  /** Caps; default = everything owed. */
  amount0Max?: bigint;
  amount1Max?: bigint;
}

/** Collect owed fees (and any tokens freed by a prior decrease) to the wallet. */
export function buildCollectV3(p: CollectV3Params): Execution[] {
  return [
    {
      target: p.nfpm,
      value: 0n,
      callData: encodeFunctionData({
        abi: nfpmAbi,
        functionName: "collect",
        args: [
          {
            tokenId: p.tokenId,
            recipient: p.recipient,
            amount0Max: p.amount0Max ?? MAX_UINT128,
            amount1Max: p.amount1Max ?? MAX_UINT128,
          },
        ],
      }),
    },
  ];
}

/** Burn an empty position (liquidity and owed fees must already be 0). */
export function buildBurnV3(nfpm: Address, tokenId: bigint): Execution[] {
  return [
    {
      target: nfpm,
      value: 0n,
      callData: encodeFunctionData({ abi: nfpmAbi, functionName: "burn", args: [tokenId] }),
    },
  ];
}

function approveTo(token: Address, spender: Address, amount: bigint): Execution {
  return {
    target: token,
    value: 0n,
    callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  };
}
