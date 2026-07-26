/**
 * `client.aave.*` — Aave v3 lending surface for an Agent Wallet.
 *
 * Reads come from `read.ts`; writes are encoded in `write.ts` and submitted
 * through the same `client.run` / `client.dryRun` path as every other action, so
 * they share revert decoding, structured results and the on-chain limit checks.
 *
 * Amounts are human strings resolved against the token's real decimals (never
 * guessed). `to`/`onBehalfOf` are never parameters — they are pinned to the wallet
 * by the call policies, and the builders pass the wallet accordingly.
 */
import { parseUnits, type Address } from "viem";

import type { BvccAgentClient } from "../client.js";
import { resolveToken } from "../tokens.js";
import type { ActionResult } from "../results.js";
import type { DryRunResult } from "../types.js";
import { getAaveAddresses } from "./addresses.js";
import {
  executePlan,
  planClosePosition,
  planCollateralSwap,
  planDebtSwap,
  planRepayWithCollateral,
  type AavePlan,
  type AavePlanExecution,
} from "./plans.js";
import {
  buildBorrow,
  buildRepay,
  buildRepayWithATokens,
  buildSetCollateral,
  buildSetEMode,
  buildSupply,
  buildWithdraw,
} from "./write.js";
import {
  getAccountData,
  getReserves,
  getUserPositions,
  maxSafeBorrowBase,
  maxSafeWithdrawBase,
  repayToReachHFBase,
  type AaveAccountData,
  type AaveReserveInfo,
  type AaveUserPosition,
} from "./read.js";

/** Interest buffer added to a "max" repay approval to cover accrual between read and mine. */
const REPAY_APPROVE_BUFFER_BPS = 10n; // 0.10%

export class AaveClient {
  constructor(private readonly client: BvccAgentClient) {}

  private get chainId(): number {
    return this.client.network.chainId;
  }

  private pool(): Address {
    const a = getAaveAddresses(this.chainId);
    if (!a) throw new Error(`Aave is not supported on chain ${this.chainId} in this SDK.`);
    return a.pool;
  }

  /** Resolve a token symbol/address to its address + real decimals. */
  private async decimals(token: string): Promise<{ address: Address; decimals: number }> {
    const info = resolveToken(this.chainId, token);
    if (info.decimals != null) return { address: info.address, decimals: info.decimals };
    const d = (await this.client.publicClient.readContract({
      address: info.address,
      abi: [
        { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
      ] as const,
      functionName: "decimals",
    })) as number;
    return { address: info.address, decimals: d };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  getAccountData(user?: Address): Promise<AaveAccountData> {
    return getAccountData(this.client.publicClient, this.chainId, user ?? this.client.walletAddress);
  }
  getPositions(user?: Address): Promise<AaveUserPosition[]> {
    return getUserPositions(this.client.publicClient, this.chainId, user ?? this.client.walletAddress);
  }
  getReserves(assets?: (Address | string)[]): Promise<AaveReserveInfo[]> {
    return getReserves(this.client.publicClient, this.chainId, assets);
  }

  /** Max borrow of `asset` (human units) keeping HF ≥ targetHF (default 1.5). */
  async maxSafeBorrow(asset: string, targetHF = "1.5"): Promise<string> {
    const [acc, { decimals, address }, reserves] = await Promise.all([
      this.getAccountData(),
      this.decimals(asset),
      this.getReserves([asset]),
    ]);
    const priceUsd = Number(reserves[0]?.priceUsd ?? "0");
    if (priceUsd <= 0) return "0";
    const capBase = maxSafeBorrowBase(
      { totalCollateralBase: acc.totalCollateralBase, totalDebtBase: acc.totalDebtBase, liquidationThresholdBps: acc.currentLiquidationThreshold },
      parseUnits(targetHF, 18),
    );
    // base currency (1e8 USD) → asset units
    const assetUnits = (Number(capBase) / 1e8 / priceUsd);
    void address;
    return assetUnits.toFixed(decimals);
  }

  // ── Planners (multi-chunk) ─────────────────────────────────────────────────

  /** Project a chunked deleverage without sending anything. */
  planRepayWithCollateral(
    params: Parameters<typeof planRepayWithCollateral>[1],
  ): Promise<AavePlan> {
    return planRepayWithCollateral(this.client, params);
  }

  /** Project migrating collateral from one asset to another. */
  planCollateralSwap(params: Parameters<typeof planCollateralSwap>[1]): Promise<AavePlan> {
    return planCollateralSwap(this.client, params);
  }

  /** Project moving a debt from one asset to another. */
  planDebtSwap(params: Parameters<typeof planDebtSwap>[1]): Promise<AavePlan> {
    return planDebtSwap(this.client, params);
  }

  /** Project closing the position, picking the cheapest viable route. */
  planClosePosition(params: Parameters<typeof planClosePosition>[1]): Promise<AavePlan> {
    return planClosePosition(this.client, params);
  }

  /**
   * Run a plan to completion. May send several transactions; each chunk is
   * re-derived from live state, re-checked and simulated before it is sent.
   */
  executePlan(params: Parameters<typeof executePlan>[1]): Promise<AavePlanExecution> {
    return executePlan(this.client, params);
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  async supply(asset: string, amount: string): Promise<ActionResult> {
    const { address, decimals } = await this.decimals(asset);
    const raw = parseUnits(amount, decimals);
    return this.client.run("aaveSupply", buildSupply(this.pool(), this.client.walletAddress, address, raw));
  }

  async withdraw(asset: string, amount: string | "max"): Promise<ActionResult> {
    const { address, decimals } = await this.decimals(asset);
    const amt = amount === "max" ? "max" : parseUnits(amount, decimals);
    return this.client.run("aaveWithdraw", buildWithdraw(this.pool(), this.client.walletAddress, address, amt));
  }

  async borrow(asset: string, amount: string): Promise<ActionResult> {
    const { address, decimals } = await this.decimals(asset);
    return this.client.run(
      "aaveBorrow",
      buildBorrow(this.pool(), this.client.walletAddress, address, parseUnits(amount, decimals)),
    );
  }

  async repay(asset: string, amount: string | "max"): Promise<ActionResult> {
    const { address, decimals } = await this.decimals(asset);
    const [amt, approveAmount] = await this.repayAmounts(address, decimals, amount);
    return this.client.run("aaveRepay", buildRepay(this.pool(), this.client.walletAddress, address, amt, approveAmount));
  }

  async repayWithATokens(asset: string, amount: string | "max"): Promise<ActionResult> {
    const { address, decimals } = await this.decimals(asset);
    const amt = amount === "max" ? "max" : parseUnits(amount, decimals);
    return this.client.run("aaveRepayWithATokens", buildRepayWithATokens(this.pool(), address, amt));
  }

  async setCollateral(asset: string, useAsCollateral: boolean): Promise<ActionResult> {
    const { address } = await this.decimals(asset);
    return this.client.run("aaveSetCollateral", buildSetCollateral(this.pool(), address, useAsCollateral));
  }

  async setEMode(categoryId: number): Promise<ActionResult> {
    return this.client.run("aaveSetEMode", buildSetEMode(this.pool(), categoryId));
  }

  // ── Dry-runs ──────────────────────────────────────────────────────────────
  // Same builders, submitted through client.dryRun (simulate + gas, no broadcast).

  async dryRunSupply(asset: string, amount: string): Promise<DryRunResult> {
    const { address, decimals } = await this.decimals(asset);
    return this.client.dryRun("aaveSupply", buildSupply(this.pool(), this.client.walletAddress, address, parseUnits(amount, decimals)));
  }
  async dryRunWithdraw(asset: string, amount: string | "max"): Promise<DryRunResult> {
    const { address, decimals } = await this.decimals(asset);
    const amt = amount === "max" ? "max" : parseUnits(amount, decimals);
    return this.client.dryRun("aaveWithdraw", buildWithdraw(this.pool(), this.client.walletAddress, address, amt));
  }
  async dryRunBorrow(asset: string, amount: string): Promise<DryRunResult> {
    const { address, decimals } = await this.decimals(asset);
    return this.client.dryRun("aaveBorrow", buildBorrow(this.pool(), this.client.walletAddress, address, parseUnits(amount, decimals)));
  }
  async dryRunRepay(asset: string, amount: string | "max"): Promise<DryRunResult> {
    const { address, decimals } = await this.decimals(asset);
    const [amt, approveAmount] = await this.repayAmounts(address, decimals, amount);
    return this.client.dryRun("aaveRepay", buildRepay(this.pool(), this.client.walletAddress, address, amt, approveAmount));
  }

  /** Resolve repay amount + the approve to authorize, handling "max" via current debt. */
  private async repayAmounts(
    asset: Address,
    decimals: number,
    amount: string | "max",
  ): Promise<[bigint | "max", bigint]> {
    if (amount !== "max") {
      const raw = parseUnits(amount, decimals);
      return [raw, raw];
    }
    // "max": approve current debt + a small buffer for interest accrued before mining.
    const pos = (await this.getPositions()).find((p) => p.asset.toLowerCase() === asset.toLowerCase());
    const debt = pos?.variableDebt ?? 0n;
    const approveAmount = debt + (debt * REPAY_APPROVE_BUFFER_BPS) / 10000n;
    return ["max", approveAmount];
  }
}
