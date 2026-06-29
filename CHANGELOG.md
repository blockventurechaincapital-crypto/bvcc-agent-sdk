# Changelog

All notable changes to `@bvcc/agent-sdk` are documented here. This project follows
[Semantic Versioning](https://semver.org/). While on `0.x`, the public API may
change between minor versions.

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
