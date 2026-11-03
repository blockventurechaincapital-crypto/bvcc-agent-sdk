# Changelog

All notable changes to `@bvcc/agent-sdk` are documented here. This project follows
[Semantic Versioning](https://semver.org/). While on `0.x`, the public API may
change between minor versions.

## [0.3.0] — 2026-11-03

Support for **wallet V5**, the new generation of the BVCC Agent Wallet. V2–V4 wallets
behave exactly as before; the client detects the generation of each wallet by itself.

### Added
- **V5 detection.** `detectWalletVersion` returns `"v5"`, read from the wallet's EIP-712
  domain (V5 has no wallet-wide `getCallPolicy`, so the domain is asked first).
  `client.walletVersion()` exposes it.
- **V5 reads.** `getPermission` merges V5's `getAgentPermission` and `getAgentSpending`
  into the usual shape and adds `paused` (this agent alone paused by the owner).
  `getRemaining`, `canSpendNative` and `canSpendToken` apply the V5 meaning of limits —
  `0` allows nothing, `type(uint128).max` is unlimited, an empty recipient list allows
  no recipient — and count the agent fee inside the limits, as the contract does.
- **V5 capabilities.** `getCapabilities` checks, per protocol, this agent's own call
  policy, an active validator in the wallet's registry and that the owner has not
  blocked the contract; it also reports missing Permit2 allowances to the Universal
  Router. `getAgentStatus` reports `walletVersion` and counts the per-agent pause.
- **Batch adaptation (`adaptBatchForV5`).** Right before a batch is sent or simulated
  on a V5 wallet the client: drops the agent's own Permit2 grants (the owner grants
  them on V5); sends SwapRouter02 swaps (`exactInputSingle`, `exactOutputSingle`,
  `exactInput`, `exactOutput`) through the Universal Router; lets native-coin swaps
  (wrapping) and Uniswap v3 liquidity through only where their validators are active
  (see below); and refuses, with a clear message, Aave `repayWithATokens`. The builders
  are unchanged.
- **Router deadlines on chain time (`refreshStaleDeadlines`).** Deadlines are set from
  the computer's clock; when that clock is behind, the router reverted with
  `TransactionDeadlinePassed`. Before sending, the client now renews any Universal
  Router or v4 PositionManager deadline that the chain already sees as past. Applies to
  every generation.
- Readable errors for V5 (`AgentPaused`, `TargetIsBlocked`, `PostCheckFailed`,
  `CallNeedsValidator`, `UnsupportedExecutionMode`, `TotalBudgetExceeded`, …), for
  Permit2 (`AllowanceExpired`, `InsufficientAllowance`) and for the Uniswap routers
  (`TransactionDeadlinePassed`, `V3TooLittleReceived`, `V3InvalidSwap`, …).
- `agentWalletV5Abi`, `validatorRegistryV5Abi`, `V5_ADDRESSES`, and the Arbitrum Sepolia
  Aave market and test USDC.
- Guides: V5 notes for getting started, swaps, lending and liquidity.

### Fixed
- **Out of gas on valid transactions.** `execute()` sent with exactly the gas estimate, so
  a batch could run out when the state moved a little before it was mined (seen on LP
  mints and decrease + collect + burn). It now estimates and sends with a 20% margin
  (`gasBufferBps` in the client options). A batch that would revert is still never sent;
  unused gas is not paid.

### Added (from the analysis of a live wallet)
- **`retryable` on every failure** (`DecodedRevert`, `ActionFailure`): `false` means the
  same call will fail again — budgets, permissions, missing balance, no debt to repay.
  Uniswap's `STF` is explained as a missing balance, and Aave's numeric codes (`39`,
  `35`, …) and named errors (`NoDebtOfSelectedType`, …) are decoded.
- **Liquidity ranges as prices.** `addLiquidityV3/V4` and their plans and dry runs take
  `priceLower` / `priceUpper` (tokenA per tokenB), converted to ticks with both tokens'
  decimals. Every non-full range is read against the pool's current price and returned
  as `range` with warnings; a range that does not contain the current price is not opened on
  the first call — the failure asks to confirm with the user — and is opened when called
  again with `allowOutOfRange: true`.
- **Source tag.** Eight bytes at the end of each `executeAsAgent` call: `"bvcc"`, the tool
  (SDK or MCP) and its version. The wallet ignores them (checked on V4 and V5 wallets,
  about 100 gas); they say nothing about the user, wallet or agent. `sourceTag: false`
  turns them off; `decodeSourceTag` reads them back. `SDK_VERSION` comes from
  package.json at build time.
- **Room for the V5 fee.** `maxSpendable(token)` returns the most that can leave the
  wallet with the agent fee on top; `sendNative` / `sendToken` and their dry runs refuse
  a whole-balance move on V5 with that figure, before any gas.

- **Uniswap v3 liquidity and native-coin swaps on V5, where their validators are active.**
  The client checks the wallet's registry before sending: with an active validator for the
  v3 NonfungiblePositionManager or the wrapped native token, those calls go through; without
  one they come back as "not active yet on this network", before any gas.
  `getCapabilities` reports `canProvideLiquidityV3` and `canWrapNative`. On V5,
  `swapToNative` / `swapFromNative` size the swap to the exact amount (the fee is charged on
  top there), so no wrapped dust is left behind.
- Stale deadlines are also renewed on Uniswap v3 mint / decrease calls.

### Changed
- On V5, Aave plans name the Universal Router as the swap protocol they need, and
  `planClosePosition` explains how to close a same-asset position instead of planning
  `repayWithATokens`.

## [0.2.2] — 2026-07-30

Maintenance release. **No API change and no behaviour change** — `src/` is byte-identical
to 0.2.1.

### Fixed
- `package-lock.json` still declared `0.1.3` while the package was published as `0.2.1`.
  It is a repository artifact — npm never ships a lockfile in the tarball, so no install
  was ever affected — but it made the repository state misleading.

### Changed
- Version raised to match `@bvcc/agent-mcp` 0.2.2, which bundles this release. The MCP
  inlines the SDK at build time rather than resolving it from npm, so pairing the version
  numbers is the simplest way to tell which SDK is inside a given MCP build.

## [0.2.1] — 2026-07-28

### Added
- **Wallet V4 awareness.** `detectWalletVersion` now returns `"v4"`, read from the wallet's
  own EIP-712 domain (every generation names it `BVCCSmartWalletV<n>`). The probe for
  `getCallPolicy` still separates V2 from the policy-aware generations; the domain
  separates those from each other.
- The three V4 reverts decode to actionable messages:
  - `AgentMustBeEOA` — V4 re-checks that the agent address carries no code on **every**
    execution, not only at authorization. An agent that later gained an EIP-7702
    delegation stops working until it is removed; the message says so and says not to
    retry.
  - `TokenCallWithValue` — a transfer/approve may no longer carry native value.
  - `ReentrantAgentExecute` — something called `execute()` while an agent batch was in
    flight. Flagged as hostile calldata rather than something to retry.

### Changed
- **Capability gating now tests `walletVersion !== "v2"`** instead of `=== "v3"`, so the
  call-policy checks apply to V4 and to any later generation. Behaviour on V2 and V3
  wallets is unchanged.
- `WalletVersion` and `getCapabilities().walletVersion` widen to `"v2" | "v3" | "v4"`.
  Code that switches exhaustively on the union will need the new arm.

### Notes
- V4 factories are live on all six networks. The SDK operates on a wallet address, so
  nothing needs reconfiguring to use V4 wallets.

## [0.2.0] — 2026-07-21

### Added
- **Wallet V3 awareness.** The SDK now understands the V3 call-policy layer, not just
  the permission struct:
  - `getCallPolicy` on the wallet ABI + a read-only `validatorRegistryAbi`; a new
    `src/policy.ts` with `decodePolicy` / `describePolicy`, `detectWalletVersion`,
    `getActiveValidator`, `wouldPassDeepValidation` and `diagnosePolicy`.
  - `getCapabilities` now gates `canSwapV3` / `canSwapV4` on the registered policies
    and the validator registry (not permissions alone) on V3 wallets, and returns
    `walletVersion` + `missingPolicies`. V2 wallets are unaffected.
  - The four V3 revert errors (`SelectorNotAllowed`, `PinnedArgMismatch`,
    `PolicyValidationFailed`, `CalldataTooShort`) now decode to actionable messages.
    `diagnosePolicy` distinguishes "no validator active" (do not retry) from
    "validator rejected this calldata" (fixable).
  - `setCallPolicy` is intentionally NOT exposed — only the wallet owner writes
    policies, via Face ID.
- **Aave v3** (`src/aave/`, `client.aave.*`): reads (`getAccountData`, `getPositions`,
  `getReserves`, `maxSafeBorrow`), writes (`supply` / `withdraw` / `borrow` / `repay` /
  `repayWithATokens` / `setCollateral` / `setEMode`) with dry-runs, and pure risk
  calculators. Beneficiary is always pinned to the wallet; `"max"` uses
  `type(uint256).max`. Arbitrum only for now.
- **Aave planners** (`client.aave.plan*` / `executePlan`): chunked deleveraging,
  closing a position, and swapping the collateral or the debt asset — no flash loans.
  Seven controls (health-factor floor, iteration bound, strict progress, price impact
  vs the Aave oracle, reserve state/caps/isolation/siloed, budget across the whole
  plan, and the intermediate dip inside a swap chunk) abort with an actionable reason
  instead of a failed transaction.
- **Native ETH swaps** (`swapToNative` / `swapFromNative`) as BVCC's own batches via
  SwapRouter02 + WETH, never the Universal Router's ADDRESS_THIS legs. The 0.15% agent
  fee applies and the tool states the cost up front.
- `nativeOut` on `swapV4` is now refused on V3 wallets before broadcasting, with a
  pointer to `swapToNative` — the router-held output it relied on is denied on-chain.
- Catalog: Aave and planner capabilities, plus a `module` label and `filterByModules`
  so a wrapper can switch whole feature groups off.

### Notes
- Wallet V3 is live on Arbitrum only; on the other chains the SDK transparently
  behaves as before (V2). Aave is Arbitrum-only in this release.

## [0.1.4] — 2026-06-29

### Added
- **Polygon** (chain id `137`): V2 factories (same CREATE2 address as every chain),
  Uniswap v3 `SwapRouter02` + `QuoterV2`, and WPOL as wrapped native. Token registry
  adds WPOL, USDC (native), DAI and WBTC. Native currency is `POL`.

## [0.1.3] — 2026-06-28

### Changed
- Catalog (LLM-facing layer) only: `getAgentStatus` now returns a `suggestedAction`
  with the onboarding URL (`https://bvccwallet.blockventurechaincapital.com`) when
  the agent is not yet authorized, so an assistant can guide the user through setup.

## [0.1.2] — 2026-06-23

### Changed
- Catalog (LLM-facing layer) only: `getNativeBalance` and `getTokenBalances` now
  return a `formatted` string that includes the token symbol (e.g. `"0.1951 USDC"`,
  `"0.000872 ETH"`). Small models were reading the raw base-unit field and
  misreporting balances (e.g. `195100` as "195,100 USDC"). `raw`/`decimals` are
  unchanged, and the underlying `client.getNativeBalance()`/`getBalances()` methods
  still return a numeric `formatted` — only the catalog wrappers add the symbol.

## [0.1.1] — 2026-06-23

### Changed
- Version aligned with `@bvcc/agent-mcp` 0.1.1. No API or behavior changes
  (metadata only).

## [0.1.0] — 2026-06-23

First public release.

### Added
- `BvccAgentClient` — operate a BVCC Agent Wallet from an off-chain agent EOA
  (signs `executeAsAgent`, pays its own gas; all limits enforced on-chain).
- Multi-network registry (`NETWORKS`, `getNetwork`): Ethereum, BNB Chain,
  Arbitrum One, Base, Arbitrum Sepolia. Same wallet address per chain (CREATE2).
- Writes: `sendNative`, `sendToken`, `approve`, Uniswap v3 (`swapExactInputV3`)
  and v4 swaps (`swapV4ExactIn`) via the Universal Router + Permit2 (no
  transfer-to-router — a wrong router reverts instead of losing funds).
- Reads: agent status, derived capabilities, native/token balances, remaining
  budgets, ERC-20 + Permit2 allowances, `needsApproval`.
- Dry-run / simulate (gas estimate + decoded revert reason; never broadcasts).
- Structured results + human-readable revert decoding (`decodeRevert`).
- On-chain quoting (v3 QuoterV2, v4 Quoter) + slippage helpers; `buildSwapPlan`.
- **Capability catalog** (`@bvcc/agent-sdk/catalog`): one declarative, Zod-typed
  list of everything an AI runtime may invoke. Wrappers (MCP, OpenClaw, ElizaOS)
  generate their tools from it — add a capability once, every wrapper gets it.
- Human `formatted` fields on amount-returning reads (small LLMs misread raw wei).

### Security
- Write swaps require slippage protection: `amountOutMinimum > 0` or an explicit
  `slippageBps`; a 0 minimum is refused. v4 swaps refuse a min derived from a v3
  price proxy — an explicit minimum is required in that case.
- Exact-amount approvals only (Permit2 and routers); never unlimited by default.
- `toBaseUnits` refuses to convert an amount when a token's decimals can't be
  verified (no silent assumption that could misprice a transfer).
- Published tarball ships no sourcemaps and excludes `.env` / examples.

[0.1.1]: https://github.com/blockventurechaincapital-crypto/bvcc-agent-sdk/releases/tag/v0.1.1
[0.1.0]: https://github.com/blockventurechaincapital-crypto/bvcc-agent-sdk/releases/tag/v0.1.0
