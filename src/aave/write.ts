/**
 * Aave v3 — write builders (Phase 2).
 *
 * Each function returns `Execution[]` for `executeAsAgent`; nothing here signs or
 * broadcasts. The wallet enforces the call policies (supply/withdraw/borrow/repay
 * pin `onBehalfOf`/`to` to the wallet), so these builders always pass the wallet
 * as the beneficiary — `onBehalfOf`/`to` are never caller-supplied.
 *
 * Design decisions locked on 20 Jul 2026:
 *  - Variable rate only (Aave v3.2 removed stable) → interestRateMode = 2 always.
 *  - "max" on withdraw/repay uses type(uint256).max, NOT a read balance: Aave
 *    rounds supply down, so an exact figure silently over-asks and reverts. This
 *    was confirmed on a fork.
 *  - The approve that precedes supply/repay is Case 2b and counts toward the
 *    token budget; if the agent has a recipient whitelist, the Pool must be in it.
 */
import { encodeFunctionData, type Address } from "viem";

import { erc20Abi } from "../abi.js";
import type { Execution } from "../types.js";

/** type(uint256).max — the sentinel Aave reads as "the whole balance/debt". */
export const MAX_UINT256 = (1n << 256n) - 1n;

/** Variable interest rate mode (the only mode after Aave v3.2). */
const VARIABLE_RATE = 2n;

/** Pool functions this module encodes. Kept minimal and write-only. */
const poolWriteAbi = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "repay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "repayWithATokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setUserUseReserveAsCollateral",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "useAsCollateral", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setUserEMode",
    stateMutability: "nonpayable",
    inputs: [{ name: "categoryId", type: "uint8" }],
    outputs: [],
  },
] as const;

function approve(token: Address, spender: Address, amount: bigint): Execution {
  return {
    target: token,
    value: 0n,
    callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  };
}

function poolCall(pool: Address, functionName: string, args: readonly unknown[]): Execution {
  return {
    target: pool,
    value: 0n,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callData: encodeFunctionData({ abi: poolWriteAbi, functionName: functionName as any, args: args as any }),
  };
}

/** [approve(Pool, amount), supply(asset, amount, wallet, 0)] */
export function buildSupply(pool: Address, wallet: Address, asset: Address, amount: bigint): Execution[] {
  return [approve(asset, pool, amount), poolCall(pool, "supply", [asset, amount, wallet, 0])];
}

/**
 * [withdraw(asset, amount, wallet)].
 * Pass `"max"` to withdraw the entire supplied balance (type(uint256).max).
 */
export function buildWithdraw(
  pool: Address,
  wallet: Address,
  asset: Address,
  amount: bigint | "max",
): Execution[] {
  const amt = amount === "max" ? MAX_UINT256 : amount;
  return [poolCall(pool, "withdraw", [asset, amt, wallet])];
}

/** [borrow(asset, amount, VARIABLE, 0, wallet)] */
export function buildBorrow(pool: Address, wallet: Address, asset: Address, amount: bigint): Execution[] {
  return [poolCall(pool, "borrow", [asset, amount, VARIABLE_RATE, 0, wallet])];
}

/**
 * [approve(Pool, approveAmount), repay(asset, amount, VARIABLE, wallet)].
 * For `"max"`, `amount` = type(uint256).max (Aave only pulls the real debt) and the
 * caller must pass a concrete `approveAmount` (current debt × ~1.001 buffer), since
 * you cannot approve an infinite pull safely against the token budget.
 */
export function buildRepay(
  pool: Address,
  wallet: Address,
  asset: Address,
  amount: bigint | "max",
  approveAmount: bigint,
): Execution[] {
  const amt = amount === "max" ? MAX_UINT256 : amount;
  return [approve(asset, pool, approveAmount), poolCall(pool, "repay", [asset, amt, VARIABLE_RATE, wallet])];
}

/**
 * [repayWithATokens(asset, amount, VARIABLE)] — repays debt using the wallet's own
 * aTokens, no underlying transfer and no approve. `"max"` repays the full debt.
 */
export function buildRepayWithATokens(pool: Address, asset: Address, amount: bigint | "max"): Execution[] {
  const amt = amount === "max" ? MAX_UINT256 : amount;
  return [poolCall(pool, "repayWithATokens", [asset, amt, VARIABLE_RATE])];
}

/** [setUserUseReserveAsCollateral(asset, useAsCollateral)] */
export function buildSetCollateral(pool: Address, asset: Address, useAsCollateral: boolean): Execution[] {
  return [poolCall(pool, "setUserUseReserveAsCollateral", [asset, useAsCollateral])];
}

/** [setUserEMode(categoryId)] — 0 disables eMode. */
export function buildSetEMode(pool: Address, categoryId: number): Execution[] {
  return [poolCall(pool, "setUserEMode", [categoryId])];
}
