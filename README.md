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

- **You** create a BVCC Agent Wallet in the dashboard and set the rules (e.g.
  "this agent can spend up to 5 USDC/day, only USDC and ETH, can swap on Uniswap").
- **Your agent** gets a key. With this SDK it can send, swap, and check balances —
  but every action is checked against your rules automatically.
- If the agent tries something outside the rules, the action simply **fails** —
  no funds move. You stay in control.

### What your agent can do with it

- Send ETH (or BNB) and tokens like USDC.
- Swap tokens on Uniswap (v3 and v4).
- Check its balances and how much of its allowance is left.
- Find out *why* an action would fail **before** trying it (so it doesn't waste gas).

---

## Get started in 3 steps

**1. Install**

```bash
npm install @bvcc/agent-sdk viem
```

**2. Give it your two values**

You need two things from the BVCC dashboard:

- **Agent key** — the secret key for the agent you authorized (keep it in an `.env`
  file, never share it).
- **Wallet address** — the address of your BVCC Agent Wallet (starts with `0x`).

```ts
import { BvccAgentClient, parseEther } from "@bvcc/agent-sdk";

const agent = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`, // the agent's secret key
  walletAddress: "0xYourWalletAddress...",                  // your Agent Wallet
  network: 42161, // Arbitrum One. Others: 1 Ethereum, 56 BNB, 8453 Base, 421614 Arbitrum testnet
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

Runnable scripts for all of the above live in [`examples/`](./examples) (01–13).

---

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
| `swapV4ExactIn` | v4 pools | Universal Router 2.1.1 + Permit2 |
| `swapViaUniversalRouter` | v3 via the classic Universal Router | classic UR + Permit2 |

The router(s) must be in the agent's `allowedProtocols` and `tokenIn` in
`allowedTokens`; output returns to the wallet. v4 pools are keyed by
`(fee, tickSpacing, hooks)`, so pass `tickSpacing` (e.g. USDC/WETH on Arbitrum =
fee `500`, tickSpacing `10`). `nativeOut: true` unwraps WETH to ETH; `path`
enables multi-hop.

The UR and v4 paths use **Permit2 funding**: `approve(token → Permit2)` +
`Permit2.approve(token → router)` + `execute(... payerIsUser=true)`. Nothing is
transferred blindly, so a wrong router address reverts instead of losing funds.
Permit2's address is hardcoded (same on every chain); the Universal Router is
preconfigured only on Arbitrum One — pass `router` on other chains. The v4 encoder
is verified byte-for-byte against a real app.uniswap.org swap and validated on
Arbitrum One.

Swap **execution** helpers take addresses; `buildSwapPlan`, `resolveToken`, and the
balance helpers also accept **symbols** from the token registry. `buildSwapPlan`
never throws on quote/read failures — it returns the plan with a warning.

### API reference

**Actions → `ActionResult`:** `sendNative` · `sendToken` · `approve` ·
`swapExactInputV3` · `swapV4ExactIn` · `swapViaUniversalRouter` · `run`

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

### Networks, tokens & fees

Factories share one address on every chain (CREATE2). Built in: Arbitrum One
(`42161`), BNB Chain (`56`), Ethereum (`1`), Base (`8453`), Arbitrum Sepolia
(`421614`). Pass a full `BvccNetwork` object, or just `rpcUrl`, for a custom
endpoint.

The token registry (`resolveToken`, `getBalances`) holds verified addresses for
common tokens per chain (Binance-Peg stables are 18 decimals on BNB Chain). Unknown
symbols throw — pass an address. Router/quoter addresses are only set where
verified; elsewhere pass them explicitly.

The wallet charges the BVCC agent fee (0.15%) automatically on-chain — you don't
encode it; it's separate from your budget accounting and from gas.

### Migration 0.1 → 0.2

The convenience methods (`sendNative`, `sendToken`, `approve`, `swapExactInputV3`,
`swapViaUniversalRouter`, `swapV4ExactIn`) now return an `ActionResult` instead of
a raw tx hash. The low-level `execute()` / `executeAndWait()` and all `build*`
helpers are unchanged.

## License

MIT
