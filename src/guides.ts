/**
 * Operating guides — the "how", on demand.
 *
 * The catalog says WHAT an agent can call; these guides say HOW to use each area
 * (the recommended sequence + the traps that make a first attempt fail). An agent
 * pulls one guide when it is about to work in an area it hasn't used — progressive
 * disclosure, so the base context stays small.
 *
 * Guides are DATA (introspectable + testable), rendered to text by `getGuide`. A
 * test (`test/guides.test.ts`) asserts every tool id named here exists in the
 * catalog and that every feature module is covered, so a guide can never drift
 * into naming a tool that isn't there.
 *
 * Content rule: guides are read by the agent. They describe operation only — never
 * the fee economics (where a fee is or isn't charged). The fee is taken on-chain
 * automatically; the agent does not need to reason about it.
 */

/** The areas a guide can cover. */
export type GuideArea = "getting-started" | "swaps" | "lending" | "liquidity";

/** One area's playbook. `tools` are catalog capability ids (verified by test). */
export interface Guide {
  area: GuideArea;
  /** The tool module this area pairs with (core | aave | lp). */
  module: "core" | "aave" | "lp";
  title: string;
  /** When the agent should reach for this area. */
  whenToUse: string;
  /** Ordered steps, each naming the real tools to call. */
  workflow: string[];
  /** The traps — what makes a naive attempt fail or misbehave. */
  gotchas: string[];
  /** Catalog capability ids that belong to this area. */
  tools: string[];
  seeAlso?: GuideArea[];
}

/** One-line summary for discovery (`listGuides`). */
export interface GuideSummary {
  area: GuideArea;
  title: string;
  whenToUse: string;
}

export const GUIDES: readonly Guide[] = [
  {
    area: "getting-started",
    module: "core",
    title: "Getting started: setup and the safe operating loop",
    whenToUse:
      "Read this first. It covers what makes the agent usable and the check-before-you-act loop every action follows.",
    workflow: [
      "Setup (one-time, done by the owner): create a BVCC Agent Wallet and authorize this agent's address with on-chain limits (allowed tokens, protocols, recipients, and spend caps). The agent's key signs and pays its own gas from a small ETH balance.",
      "Orient: getAgentStatus (authorized? expired? paused? + the rules) and getCapabilities (what you may do, with notes explaining any blocker).",
      "Check funds and headroom: getNativeBalance, getTokenBalances, getRemaining (how much of each limit is left; a null limit means unlimited/disabled).",
      "Preview before writing: a dryRun* tool (dryRunSendNative / dryRunSendToken) shows gas and any revert reason before you spend gas.",
      "Act: sendNative / sendToken (or the swap/lending/liquidity tools). A blocked action reverts on-chain — read the humanMessage/suggestedAction and adjust; do not retry blindly.",
    ],
    gotchas: [
      "The contract enforces every limit. The SDK only predicts — a passing dryRun is not a guarantee, since state can change before the tx lands.",
      "You pay gas from the agent's own ETH balance; keep it funded or transactions fail to send.",
      "Recipient whitelist: when active, sends only reach listed addresses; an empty whitelist means any recipient is allowed.",
      "Amounts are human decimal strings ('0.1'); tokens are symbols ('USDC') or 0x addresses.",
      "Every tool takes an optional network (chain id or name); the agent must be authorized on the chain you target.",
    ],
    tools: [
      "getAgentStatus",
      "getCapabilities",
      "getNativeBalance",
      "getTokenBalances",
      "getRemaining",
      "dryRunSendNative",
      "dryRunSendToken",
      "sendNative",
      "sendToken",
    ],
    seeAlso: ["swaps", "lending", "liquidity"],
  },
  {
    area: "swaps",
    module: "core",
    title: "Swapping tokens (Uniswap v3 & v4)",
    whenToUse: "To exchange one token for another, or to and from native ETH.",
    workflow: [
      "Quote first: buildSwapPlan (quote: true) resolves the pool, tells you whether an approval is needed, and fills amountOutMinimum from an on-chain quote.",
      "Simulate: dryRunSwapV3 or dryRunSwapV4 to check gas and any revert before sending.",
      "Swap: swapV3 (SwapRouter02) or swapV4 (Universal Router + Permit2). v4 pools are keyed by (fee, tickSpacing) — pass tickSpacing, e.g. 500/10 for USDC/WETH 0.05%.",
      "Native ETH: swapToNative (token → ETH) and swapFromNative (ETH → token); or swapV4 with nativeOut to receive ETH from a v4 native pool.",
    ],
    gotchas: [
      "amountOutMinimum is your slippage floor — pass it (or slippageBps). '0' is refused. Quote close to when you swap.",
      "The per-token per-tx limit is consumed by the approve cap / amountInMaximum, not by what is actually spent — leave headroom for the cap.",
      "swapV4 needs BOTH the Universal Router and Permit2 in allowedProtocols, and tokenIn in allowedTokens.",
      "Output always returns to the wallet; a swap cannot deliver to another address.",
    ],
    tools: [
      "buildSwapPlan",
      "needsApproval",
      "approve",
      "dryRunSwapV3",
      "dryRunSwapV4",
      "swapV3",
      "swapV4",
      "swapToNative",
      "swapFromNative",
    ],
    seeAlso: ["getting-started", "liquidity"],
  },
  {
    area: "lending",
    module: "aave",
    title: "Lending on Aave v3 (supply, borrow, unwind)",
    whenToUse:
      "To deposit collateral, borrow against it, repay, withdraw, or safely unwind a position.",
    workflow: [
      "Read state: getAavePositions (health factor, collateral, debt per reserve) and getAaveMarket (rates and what a reserve allows).",
      "Simple actions: aaveSupply, aaveBorrow, aaveRepay ('max' clears the debt including interest), aaveWithdraw ('max' takes the whole balance). Everything is for the wallet itself — there is no recipient parameter.",
      "Preview: dryRunAaveSupply / dryRunAaveBorrow before writing.",
      "Unwinding: call a planner FIRST (aavePlanClosePosition / aavePlanDeleverage / aavePlanCollateralSwap / aavePlanDebtSwap) to see the chunks and where health lands, THEN run the matching write (aaveClosePosition / aaveDeleverage / aaveCollateralSwap / aaveDebtSwap). One execute may broadcast several transactions.",
    ],
    gotchas: [
      "Unwinding runs a chunked loop; slippageBps is required. It stops rather than proceeds if a chunk would push health below hfFloor (default 1.05), if a swap prices too far from the Aave oracle, if the loop stops reducing debt, or if the budget would run out — read the abort reason.",
      "You cannot withdraw collateral that backs debt; that is why unwinding works in chunks. If a position is too tight to chunk, the abort tells you how much to repay from the wallet to unblock it.",
      "aaveRepayWithATokens repays from your aTokens without a swap; aaveSetCollateral and aaveSetEMode change position configuration.",
      "Available on Arbitrum, Ethereum, BNB, Base and Polygon; the agent must have the Aave Pool in allowedProtocols on the chain you target.",
    ],
    tools: [
      "getAavePositions",
      "getAaveMarket",
      "dryRunAaveSupply",
      "dryRunAaveBorrow",
      "aaveSupply",
      "aaveBorrow",
      "aaveRepay",
      "aaveWithdraw",
      "aaveRepayWithATokens",
      "aaveSetCollateral",
      "aaveSetEMode",
      "aavePlanClosePosition",
      "aavePlanDeleverage",
      "aavePlanCollateralSwap",
      "aavePlanDebtSwap",
      "aaveClosePosition",
      "aaveDeleverage",
      "aaveCollateralSwap",
      "aaveDebtSwap",
    ],
    seeAlso: ["getting-started", "swaps"],
  },
  {
    area: "liquidity",
    module: "lp",
    title: "Providing liquidity (Uniswap v3 & v4)",
    whenToUse: "To open a liquidity position, collect its fees, and close it.",
    workflow: [
      "Open (v3): addLiquidityV3 with the pair, fee, and amountA/amountB (the MOST you'll deposit of each). The SDK reads the pool price and sizes both sides to the ratio; full-range by default, or pass tickLower/tickUpper for a range. Preview with dryRunAddLiquidityV3.",
      "Open (v4): addLiquidityV4 — same shape (tokenA/tokenB), and native-ETH pools work (pass the native sentinel as one side). Preview with dryRunAddLiquidityV4.",
      "Inspect: getV3Position / getV4Position (range, liquidity, owed fees).",
      "Collect fees: collectFeesV3 / collectFeesV4 sweep earned fees to the wallet.",
      "Close: removeLiquidityV3 / removeLiquidityV4 with { tokenId, bps, burn } (bps 10000 = all; burn: true also burns the emptied NFT). burnV3 / burnV4 burn an already-empty NFT.",
    ],
    gotchas: [
      "There is no increaseLiquidity — to add to an existing position you mint a fresh one (the v3 NFPM's increase is not owner-gated, so it is deliberately excluded).",
      "amountA/amountB are maximums; after sizing to the pool ratio one side is usually only partly used.",
      "The position NFT is minted to the wallet and every proceed returns to the wallet — pinned on-chain.",
      "v4 liquidity needs the v4 PositionManager's DEEP validator active on-chain for the agent; until then a v4 mint fails closed. v3 works without it.",
      "v3 is ERC-20/ERC-20 only; native-ETH pools are v4 only.",
    ],
    tools: [
      "addLiquidityV3",
      "dryRunAddLiquidityV3",
      "getV3Position",
      "collectFeesV3",
      "removeLiquidityV3",
      "dryRunRemoveLiquidityV3",
      "burnV3",
      "addLiquidityV4",
      "dryRunAddLiquidityV4",
      "getV4Position",
      "collectFeesV4",
      "removeLiquidityV4",
      "dryRunRemoveLiquidityV4",
      "burnV4",
    ],
    seeAlso: ["getting-started", "swaps"],
  },
];

/** All guides, one line each — for discovery before pulling a full guide. */
export function listGuides(): GuideSummary[] {
  return GUIDES.map((g) => ({ area: g.area, title: g.title, whenToUse: g.whenToUse }));
}

/** The full playbook for one area, as readable text. Throws on an unknown area. */
export function getGuide(area: string): string {
  const g = GUIDES.find((x) => x.area === area);
  if (!g) {
    const areas = GUIDES.map((x) => x.area).join(", ");
    throw new Error(`No guide for "${area}". Available areas: ${areas}. Call listGuides for the list.`);
  }
  return renderGuide(g);
}

function renderGuide(g: Guide): string {
  const lines: string[] = [];
  lines.push(`# ${g.title}`);
  lines.push("");
  lines.push(`When to use: ${g.whenToUse}`);
  lines.push("");
  lines.push("Workflow:");
  g.workflow.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("");
  lines.push("Watch out for:");
  g.gotchas.forEach((s) => lines.push(`- ${s}`));
  lines.push("");
  lines.push(`Tools in this area: ${g.tools.join(", ")}`);
  if (g.seeAlso?.length) lines.push(`See also: ${g.seeAlso.join(", ")}`);
  return lines.join("\n");
}
