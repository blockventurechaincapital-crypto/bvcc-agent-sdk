<p align="center">
  <img src="https://raw.githubusercontent.com/blockventurechaincapital-crypto/bvcc-agent-sdk/main/assets/bvcc_wallet.png" alt="BVCC Wallet" width="180" />
</p>

# @bvcc/agent-sdk

**Give your AI agent a wallet it can use on its own — inside spending limits you
set.**

Think of it like a prepaid card you hand to a bot: it can send funds and swap
tokens by itself, but only up to the daily amount, only the tokens you allow, and
only to the places you allow. Those limits live on the blockchain, so the agent
*physically cannot* go past them — not even if something goes wrong.

This package is the toolkit your agent (Hermes, ElizaOS, a trading bot, a script…)
uses to actually move funds within those rules.

> ⚠️ Beta software. It is non-custodial: **you** hold the keys, BVCC never can.
> The agent's key is "live", so always keep it secret and start with small limits.
> Try it on a test network (Arbitrum Sepolia) before using real money.

---

## In plain terms

- **You** create a BVCC Agent Wallet and authorize an agent in the dashboard: you
  paste the agent's **public address** and set its rules (e.g. "up to 5 USDC/day,
  only USDC and ETH, may swap on Uniswap"), then sign with Face ID.
- **The agent** has its own keypair — you generate it; BVCC never issues or sees
  it. With its key and this SDK it can send, swap, and check balances, and every
  action is checked against your rules automatically.
- If it tries something outside the rules, the action simply **fails** — no funds
  move. You stay in control.

### What your agent can do with it

- Send ETH (or BNB) and tokens like USDC.
- Swap tokens on Uniswap (v3 and v4), and to or from native ETH.
- Provide liquidity on Uniswap (v3 and v4, including native-ETH pools): open a
  position, collect its fees, and close it — proceeds always return to the wallet.
- Lend and borrow on Aave: deposit, borrow, repay, withdraw.
- **Unwind an Aave position on its own** — sell collateral to repay debt step by
  step, or close the whole thing, without ever letting the position get unsafe.
- Check its balances and how much of its allowance is left.
- Find out *why* an action would fail **before** trying it (so it doesn't waste gas).

---

## Get started in 3 steps

**1. Install**

```bash
npm install @bvcc/agent-sdk viem
```

**2. Give it your two values**

You need two things:

- **Wallet address** — your BVCC Agent Wallet address, from the dashboard (starts
  with `0x`).
- **Agent key** — the *private key* of the agent you authorized. You create this
  keypair yourself, authorize its **public address** in the dashboard, and keep the
  private key secret in an `.env` file. BVCC never issues or sees it.

> First time? Generate an agent keypair, then authorize the printed address in the
> dashboard:
> ```ts
> import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
> const key = generatePrivateKey();
> console.log("Authorize this address in the dashboard:", privateKeyToAccount(key).address);
> console.log("Save this as AGENT_PRIVATE_KEY (keep it secret):", key);
> ```

```ts
import { BvccAgentClient, parseEther } from "@bvcc/agent-sdk";

const agent = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`, // the agent's secret key
  walletAddress: "0xYourWalletAddress...",                  // your Agent Wallet
  network: 42161, // Arbitrum One. Others: 1 Ethereum, 56 BNB, 8453 Base, 137 Polygon, 421614 Arbitrum testnet
});
```

**3. Do something**

```ts
const result = await agent.sendNative("0xFriend...", parseEther("0.01"));

if (result.ok) {
  console.log("Done! Transaction:", result.txHash);
} else {
  console.log("It didn't go through:", result.humanMessage);
  console.log("Try this:", result.suggestedAction);
}
```

Every action answers the same way: either `ok: true` with a transaction hash, or
`ok: false` with a **plain-English reason** and a suggestion. No cryptic errors.

---

## A few things people ask

**Who pays the network fee (gas)?**
The agent's key does, from its own small balance. So fund the agent address with a
little ETH (on Arbitrum, cents). It never touches your main wallet for gas.

**What if the agent's key leaks?**
Whoever has it can only act *within the limits you set on-chain* — they can't drain
the wallet, change the limits, or move disallowed tokens. Set tight limits and you
cap the worst case. (Still: treat the key like a password.)

**Is my money safe with BVCC?**
BVCC never holds your keys or funds and can't move them. Everything is enforced by
the wallet contract on the blockchain, not by us.

**Can it spend more than I allowed?**
No. The blockchain rejects it. This SDK can *predict* what will happen, but the
contract is what actually enforces the rules.

**Do I need to know Solidity / smart contracts?**
No. If you can copy two values and call a function, you can use it.

---

## Common actions

```ts
import { parseEther, parseUnits } from "@bvcc/agent-sdk";

// Send native coin (ETH/BNB)
await agent.sendNative(to, parseEther("0.01"));

// Send a token (USDC has 6 decimals → parseUnits("5", 6) = 5 USDC)
await agent.sendToken(usdcAddress, to, parseUnits("5", 6));

// Swap on Uniswap v3
await agent.swapExactInputV3({
  tokenIn: usdc, tokenOut: weth,
  amountIn: parseUnits("10", 6),
  amountOutMinimum: minOut, // the least you'll accept — quote it first (see below)
  fee: 500,
});

// Swap on Uniswap v4
await agent.swapV4ExactIn({
  tokenIn: usdc, tokenOut: weth,
  amountIn: parseUnits("10", 6),
  amountOutMinimum: minOut,
  fee: 500, tickSpacing: 10,
});
```

### Swap to and from native ETH

Uniswap works with WETH, not raw ETH, so these batches wrap or unwrap for you and
keep every hop's recipient as the wallet.

```ts
// token → ETH. Exact output: you get precisely this much ETH, no dust left over.
await agent.swapToNative({
  tokenIn: usdc,
  amountOut: parseEther("0.01"),      // exactly what you want to receive
  amountInMaximum: parseUnits("25", 6), // your price protection — required
  fee: 500,
});

// ETH → token.
await agent.swapFromNative({
  tokenOut: usdc,
  amountIn: parseEther("0.01"),
  amountOutMinimum: minOut,
  fee: 500,
});
```

To go between ETH and WETH, wrap or unwrap. It is not a swap, and there is no pool for it:

```ts
await agent.wrapNative(parseEther("0.01"));   // ETH → WETH, one to one
await agent.unwrapNative(parseEther("0.01")); // WETH → ETH
```

`swapFromNative` with WETH as `tokenOut`, or `swapToNative` with WETH as `tokenIn`, does
the same wrap or unwrap. A single-hop swap from a token to itself is refused before any
gas, with `retryable: false`. WETH has to be in `allowedProtocols`; on wallet V5 it also
needs `getCapabilities().canWrapNative`. Fees: before V5, a wrap keeps the amount minus
0.15% as WETH and an unwrap is free; on V5 the 0.15% is paid on top, in ETH for a wrap and
in WETH for an unwrap.

### Provide liquidity on Uniswap (v3 & v4)

Open a position, collect its fees, and close it. The position NFT is minted **to
the wallet** and every proceed is taken back **to the wallet** — pinned on-chain,
same as everything else.

```ts
// v3: mint a position. amountA/amountB are the MOST you'll deposit of each token;
// the SDK reads the pool price and sizes both sides to the ratio (one side is
// usually only partly used). Full-range by default; pass ticks for a range.
const mint = await agent.addLiquidityV3({
  tokenA: weth, tokenB: usdc, fee: 500,
  amountA: parseEther("0.01"), amountB: parseUnits("30", 6),
  slippageBps: 50,
});

const pos = await agent.getV3Position(tokenId);        // range, liquidity, owed fees
await agent.collectFeesV3(tokenId);                    // sweep earned fees to the wallet
await agent.removeLiquidityV3({ tokenId, bps: 10000, burn: true }); // close + burn the NFT
```

```ts
// v4: same shape (tokenA/tokenB), and native-ETH pools work here — pass V4_NATIVE
// (address(0)) as a side; it's funded by msg.value, ERC-20 sides via Permit2. Needs
// the v4 PositionManager and, for the agent, its on-chain DEEP validator active —
// otherwise the mint fails closed.
import { V4_NATIVE } from "@bvcc/agent-sdk";

await agent.addLiquidityV4({
  tokenA: V4_NATIVE, tokenB: usdc, fee: 500, tickSpacing: 10,
  amountA: parseEther("0.01"), amountB: parseUnits("30", 6),
  slippageBps: 50,
});
await agent.removeLiquidityV4({ tokenId, bps: 10000, burn: true });
```

One note worth knowing: there is **no `increaseLiquidity`** — the v3 NFPM's
`increaseLiquidity` is not owner-gated, so to add you mint a fresh position rather
than top up an existing one (v4 gates it, so v4 has it).

### Lending on Aave v3

Aave is wired on **Arbitrum, Ethereum, BNB Chain, Base and Polygon** (every address
resolved on-chain from each market's PoolAddressesProvider). Everything is
deposited, borrowed and repaid **for the wallet itself** — there is no `to` or
`onBehalfOf` parameter, because the wallet's call policies pin the beneficiary
on-chain.

```ts
// Where do we stand?
const { account, positions } = {
  account: await agent.aave.getAccountData(),  // health factor, collateral, debt
  positions: await agent.aave.getPositions(),  // per-reserve supplied / borrowed
};

await agent.aave.supply("USDC", "100");
await agent.aave.borrow("WETH", "0.02");
await agent.aave.repay("WETH", "max");     // "max" clears the debt including interest
await agent.aave.withdraw("USDC", "max");  // "max" takes the whole balance
```

### Unwinding a position (planners)

Collateral backs your debt, so you cannot simply withdraw it, and you cannot repay
because your money is locked as collateral. Without flash loans the way out is to
work in chunks: withdraw what safety allows, swap it, repay, which frees more
collateral, repeat.

Every planner comes in pairs — `plan*` projects and sends nothing, the other runs
the loop. **A single execute call can broadcast several transactions.**

```ts
// See what it intends to do first: how many chunks, and where health lands.
const plan = await agent.aave.planClosePosition({ slippageBps: 100, hfFloor: "1.05" });
console.log(plan.summary, plan.chunks.map((c) => c.description));

// Then run it. Each chunk is re-derived from live state, re-checked against every
// control and simulated before it is sent.
const result = await agent.aave.executePlan({ kind: "closePosition", slippageBps: 100 });
console.log(result.chunksCompleted, result.txHashes);

// Also available: deleverage, and swapping the collateral or the debt asset.
await agent.aave.planRepayWithCollateral({ collateralAsset: "USDC", debtAsset: "WETH", slippageBps: 100 });
await agent.aave.planCollateralSwap({ fromAsset: "USDC", toAsset: "WETH", slippageBps: 100 });
await agent.aave.planDebtSwap({ fromDebtAsset: "WETH", toDebtAsset: "USDC", slippageBps: 100 });
```

`closePosition` avoids the loop when it can: if the wallet already holds enough of
the debt asset it repays directly, and if debt and collateral are the same asset it
repays straight from aTokens without swapping.

**The controls that make this safe to run unattended.** `slippageBps` is required;
the rest have conservative defaults. A violation aborts with a reason you can act
on rather than a failed transaction.

| Control | Default | Stops |
|---|---|---|
| `hfFloor` | `"1.05"` | any chunk that would push health below it |
| `maximumIterations` | `10` | an endless loop |
| `maxPriceImpactBps` | `200` | swapping far off the Aave oracle price |
| `minimumChunkAmount` | none | dust chunks that only burn gas |
| strict progress | always | a loop that stops reducing the debt |
| budget check | always | running out of allowance mid-way |

If the position is too tight to chunk at all, the abort tells you **how much debt to
repay from the wallet to unblock it** — not just "infeasible".

### Check before you act (saves gas)

```ts
// Will this swap work? Simulate it without sending. If not, get the reason.
const check = await agent.dryRunSwapV4({
  tokenIn: usdc, tokenOut: weth, amountIn: parseUnits("0.1", 6),
  amountOutMinimum: 1n, fee: 500, tickSpacing: 10,
});
if (!check.ok) console.log("Would fail:", check.failure?.humanMessage);

// Or plan a swap and let the SDK fetch a price quote + set a safe minimum:
const plan = await agent.buildSwapPlan({
  protocol: "v4", tokenIn: "USDC", tokenOut: "WETH",
  amountIn: parseUnits("0.1", 6), fee: 500, tickSpacing: 10,
  quote: true, slippageBps: 50, // 0.5%
});
```

### See what the agent can do and what it has

```ts
const status = await agent.getAgentStatus();   // active? expired? paused? + your rules
const caps   = await agent.getCapabilities();  // can it send? swap v3/v4? + helpful notes
const eth    = await agent.getNativeBalance();
const tokens = await agent.getBalances(["USDC", "WETH"]); // names or addresses
const left   = await agent.getRemaining();     // how much of each limit is left
```

Runnable scripts for all of the above live in [`examples/`](https://github.com/blockventurechaincapital-crypto/bvcc-agent-sdk/tree/main/examples) (01–13).

---

## Wallet V5

The SDK works with every wallet generation and finds out which one it is talking to
by itself (`await agent.walletVersion()`). On a **V5** wallet a few things change:

- **Limits:** `0` allows nothing (before V5 it meant unlimited) and an empty recipient
  list allows no recipient. Limits count the agent fee too, so stay a little under them.
  `getRemaining` and the `canSpend*` checks already apply these rules.
- **Swaps** run through the Universal Router, between ERC-20 tokens. `swapExactInputV3`
  keeps working: on V5 the client sends it through the Universal Router for you.
  Native-coin swaps (wrapping) and **Uniswap v3 liquidity** work where their validators are
  active on that network — `getCapabilities` says so (`canWrapNative`,
  `canProvideLiquidityV3`); elsewhere use WETH and v4 liquidity.
- **Permit2** allowances for swaps and v4 liquidity are granted by the wallet owner when
  authorizing or renewing the agent. The client leaves them out of the agent's batch.
- **Liquidity:** Uniswap v4, and v3 where its validator is active. **Aave:** everything except `repayWithATokens`, and the
  health factor must stay at or above 1.2 after each batch.
- The owner can **pause** one agent, **block** a contract for every agent and **renew**
  the expiry. `getAgentStatus` and `getCapabilities` report all of it, with notes.

Anything V5 does not allow comes back as a failed result with a plain explanation
(`errorName: "V5Unsupported"`), before any gas is spent.

## Good to know

- **Never twice.** A write is reported as done only once it is confirmed. If it may be
  on-chain but is not confirmed yet, the result is `NotYetConfirmed` or
  `SubmissionUnknown`, with its `txHash` and `retryable: false`: check that hash before
  repeating anything. Operations from one client go out one at a time.
- **Retry or not.** Every failed result carries `retryable`. When it is `false` the same
  call will fail again (a budget is used up, a permission is missing, the balance is
  short): change the input or ask the owner instead of repeating it.
- **Liquidity ranges as prices.** Pass `priceLower` / `priceUpper` — how many `tokenA` one
  `tokenB` is worth — rather than raw ticks. A range that does not contain the current
  price needs a confirmation: the first call stops and asks, and `allowOutOfRange: true` opens it; the result shows the range
  read against the current price.
- **Gas margin.** Transactions are sent with 20% more gas than the estimate
  (`gasBufferBps`); unused gas is not paid.
- **Source tag.** Each transaction ends with 8 bytes naming the tool that built it (this
  SDK or the BVCC MCP) and its version, so BVCC can tell which releases are in use and
  tie failures to a version. It carries nothing about you, your wallet or your agent,
  and the wallet ignores it. Turn it off with `new BvccAgentClient({ ..., sourceTag: false })`.
- **Update check.** The first time you call `getAgentStatus`, the client asks the public
  npm registry which version of `@bvcc/agent-sdk` is the latest. It is a single GET that
  gives up after 2 seconds, and creating the client does not trigger it. When a newer
  version is out, the status includes `updateAvailable: { current, latest, command,
  changelogUrl }`. If the registry is slow or down, you get the status without that
  field. The request carries nothing about you, your wallet or your agent, though npm
  does see your IP address, the same as with any `npm install`. To turn it off, pass
  `updateCheck: false` to `new BvccAgentClient({ ... })` or set `BVCC_NO_UPDATE_CHECK=1`.

## For developers

The rest is reference detail. The plain-language part above is enough to use the SDK.

### How it works under the hood

A BVCC Agent Wallet is a smart wallet (ERC-4337 / ERC-7821). The owner authorizes
an **agent EOA** (a normal wallet address) with on-chain spending rules: per-tx,
daily, rolling-period and lifetime budgets, per-token limits, and token / protocol
/ recipient whitelists.

The agent path is deliberately simple — the agent is a plain EOA that signs a
normal transaction calling `executeAsAgent`, pays its own gas, and the wallet
enforces every limit. No Account Abstraction, bundler, or WebAuthn here; the
owner's Face ID signer is only used to *authorize* the agent from the dashboard.

```
agent EOA ──(normal tx, pays gas)──▶ AgentWallet.executeAsAgent(batch)
                                         └─ enforces limits, then runs the batch
```

**The contract is the source of truth.** Everything this SDK adds (`canSpend*`,
`dryRun*`, `getCapabilities`, `buildSwapPlan`, `explainFailure`) only *predicts and
explains* — it never enforces or bypasses the rules, and a passing preflight is not
a guarantee (state can change before the tx lands). The SDK never logs or stores
private keys; decoded errors contain selectors and addresses only.

### Structured results

Action methods return a discriminated `ActionResult`:

```ts
type ActionResult =
  | { ok: true;  action; txHash; network; chainId; walletAddress; agentAddress }
  | { ok: false; action; errorName; humanMessage; suggestedAction; rawError;
      network; chainId; walletAddress; agentAddress };
```

`explainFailure(error)` (or the exported `decodeRevert`) turns any revert — a viem
error or raw revert data — into `{ errorName, humanMessage, suggestedAction,
rawError }`, mapping the wallet's custom errors (limits, whitelists, expiry, pause)
to plain language. Selectors are computed at load, so they never drift.

### Batching & low-level primitives

```ts
// Several actions in one atomic transaction:
await agent.execute([
  agent.buildSendToken(usdc, alice, 1_000_000n),
  agent.buildSendNative(bob, parseEther("0.001")),
]);
```

`execute()` → tx hash and `executeAndWait()` → receipt are the low-level
primitives (unchanged across versions). `build*` helpers are pure and return
`Execution` items you can compose. `run(action, executions)` sends a batch and
returns an `ActionResult`.

### Swaps in detail

| Helper | Use for | Router |
| --- | --- | --- |
| `swapExactInputV3` | v3 pools (simplest, widely whitelisted) | SwapRouter02 |
| `swapV4ExactIn` | v4 pools | Universal Router (canonical) + Permit2 |
| `swapViaUniversalRouter` | v3 via the classic Universal Router | classic UR + Permit2 |

The router(s) must be in the agent's `allowedProtocols` and `tokenIn` in
`allowedTokens`; output returns to the wallet. v4 pools are keyed by
`(fee, tickSpacing, hooks)`, so pass `tickSpacing` (e.g. USDC/WETH on Arbitrum =
fee `500`, tickSpacing `10`). `nativeOut: true` routes through the **native
(address(0)) pool** and delivers ETH straight to the wallet — no WETH, no unwrap
leg (the agent's UR validator forbids parking output in the router). `path`
enables multi-hop.

The UR and v4 paths use **Permit2 funding**: `approve(token → Permit2)` +
`Permit2.approve(token → router)` + `execute(... payerIsUser=true)` (on V5 the owner
grants both allowances and the client leaves them out of the batch). Nothing is
transferred blindly, so a wrong router address reverts instead of losing funds.
Permit2's address is hardcoded (same on every chain); the Universal Router is
preconfigured on the supported chains — pass `router` for a custom endpoint. The
v4 swap encoder uses the canonical v4-periphery `ExactInputParams` and is validated
on-chain against the deployed Universal Router validator (Arbitrum One).

Swap **execution** helpers take addresses; `buildSwapPlan`, `resolveToken`, and the
balance helpers also accept **symbols** from the token registry. `buildSwapPlan`
never throws on quote/read failures — it returns the plan with a warning.

### API reference

**Actions → `ActionResult`:** `sendNative` · `sendToken` · `approve` ·
`swapExactInputV3` · `swapV4ExactIn` · `swapViaUniversalRouter` · `swapToNative` ·
`swapFromNative` · `run`

**Aave (`client.aave.*`):** reads `getAccountData` · `getPositions` · `getReserves`
· `maxSafeBorrow` — writes `supply` · `withdraw` · `borrow` · `repay` ·
`repayWithATokens` · `setCollateral` · `setEMode` — simulate `dryRunSupply` ·
`dryRunWithdraw` · `dryRunBorrow` · `dryRunRepay`

**Aave planners:** `planRepayWithCollateral` · `planClosePosition` ·
`planCollateralSwap` · `planDebtSwap` (all projection-only) · `executePlan` (runs
the loop; may send several transactions)

**Liquidity (Uniswap v3 & v4):** `addLiquidityV3` · `removeLiquidityV3` ·
`collectFeesV3` · `burnV3` · `getV3Position` · `planAddLiquidityV3` — and the v4
equivalents `addLiquidityV4` · `removeLiquidityV4` · `collectFeesV4` · `burnV4` ·
`getV4Position` · `planAddLiquidityV4` (native-ETH pools). Simulate with
`dryRunAddLiquidityV3/V4` · `dryRunRemoveLiquidityV3/V4`.

**V3 call policies:** `getPolicy` · `decodePolicy` · `describePolicy` ·
`diagnosePolicy` · `detectWalletVersion` · `getActiveValidator` ·
`wouldPassDeepValidation`

**Low-level:** `execute` → `Hex` · `executeAndWait` → receipt · `build*` →
`Execution[]` · `encodeExecutions`

**Reads:** `getAgentStatus` · `getCapabilities` · `getRemaining` · `getPermission`
· `getNativeBalance` · `getTokenBalance` · `getBalances` · `getDailySpentNative` ·
`getTokenSpent` · `isPaused`

**Allowances:** `getErc20Allowance` · `getPermit2Allowance` · `needsApproval`

**Simulate & explain:** `dryRun` · `dryRunSendNative` · `dryRunSendToken` ·
`dryRunApprove` · `dryRunSwapV3` · `dryRunSwapV4` · `simulateAndExplain` ·
`explainFailure`

**Preflight:** `canSpendNative` · `canSpendToken` · **Planning:** `buildSwapPlan`

**Exported helpers:** `decodeRevert` · `resolveToken` · `TOKENS` · `applySlippage`
· `quoteV3ExactInputSingle` · `quoteV4ExactInputSingle` · `NETWORKS` · viem
re-exports (`parseEther`, `formatUnits`, …).

**Guides:** `listGuides()` · `getGuide(area)` · `GUIDES` — on-demand how-to
playbooks (`getting-started`, `swaps`, `lending`, `liquidity`) with the recommended
workflow and gotchas per area. Also surfaced as the `listGuides`/`getGuide`
capabilities so wrappers expose them as tools/prompts.

### Networks, tokens & fees

Factories share one address on every chain (CREATE2). Built in: Arbitrum One
(`42161`), BNB Chain (`56`), Ethereum (`1`), Base (`8453`), Polygon (`137`),
Arbitrum Sepolia (`421614`). Pass a full `BvccNetwork` object, or just `rpcUrl`,
for a custom endpoint.

The token registry (`resolveToken`, `getBalances`) holds verified addresses for
common tokens per chain (Binance-Peg stables are 18 decimals on BNB Chain). Unknown
symbols throw — pass an address. Router/quoter addresses are only set where
verified; elsewhere pass them explicitly.

The wallet charges the BVCC agent fee (0.15%) automatically on-chain — you don't
encode it; it's separate from your budget accounting and from gas.

### For AI-runtime wrappers

The SDK ships a declarative capability catalog at the subpath
`@bvcc/agent-sdk/catalog` — a single, explicit, Zod-typed list of the actions an AI
runtime may invoke. Wrappers (the [`@bvcc/agent-mcp`](https://www.npmjs.com/package/@bvcc/agent-mcp)
MCP server, and future OpenClaw / ElizaOS adapters) generate their tools from it,
so an action is described once and every runtime gets it. Importing the core SDK
does **not** pull in the catalog or Zod.

The catalog also carries two always-on help capabilities, `listGuides` and
`getGuide`, that return per-area operating guides (workflow + gotchas). A wrapper
surfaces them as tools, and can also expose them as prompts — the MCP server
registers one `guide-<area>` prompt per area.

## License

MIT
