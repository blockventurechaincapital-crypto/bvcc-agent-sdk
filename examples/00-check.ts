/**
 * Read-only connectivity + permission check. Costs nothing, broadcasts nothing.
 *
 *   set -a; . ./.env; set +a; npx tsx examples/00-check.ts
 */
import { BvccAgentClient, formatEther } from "../src/index.js";

const client = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: Number(process.env.CHAIN_ID ?? 42161),
  rpcUrl: process.env.RPC_URL,
});

const cur = client.network.currency;
const fmt = (v: bigint | null) => (v === null ? "unlimited" : `${formatEther(v)} ${cur}`);

console.log(`Network:       ${client.network.name} (${client.network.chainId})`);
console.log(`Agent EOA:     ${client.agentAddress}`);
console.log(`Agent Wallet:  ${client.walletAddress}`);

// Gas balance of the agent EOA (it pays gas).
const gas = await client.publicClient.getBalance({ address: client.agentAddress });
console.log(`Agent gas bal: ${formatEther(gas)} ${cur}`);

// Wallet native balance (source of funds for sends/swaps).
const wbal = await client.publicClient.getBalance({ address: client.walletAddress });
console.log(`Wallet bal:    ${formatEther(wbal)} ${cur}`);

const paused = await client.isPaused();
console.log(`Agents paused: ${paused}`);

const r = await client.getRemaining();
console.log(`\nAgent permission:`);
console.log(`  active=${r.active}  expired=${r.expired}`);
console.log(`  per-tx max:         ${fmt(r.maxPerTxWei)}`);
console.log(`  daily remaining:    ${fmt(r.dailyRemainingWei)}`);
console.log(`  period remaining:   ${fmt(r.periodRemainingWei)}`);
console.log(`  lifetime remaining: ${fmt(r.totalRemainingWei)}`);
for (const t of r.tokens) {
  console.log(`  token ${t.token}`);
  console.log(`    daily remaining: ${t.dailyRemaining === null ? "unlimited" : t.dailyRemaining}`);
  console.log(`    total remaining: ${t.totalRemaining === null ? "unlimited" : t.totalRemaining}`);
}

if (!r.active) console.log(`\n⚠️  Agent is NOT active on this wallet — authorize it first or check the addresses.`);
else if (r.expired) console.log(`\n⚠️  Agent permission has EXPIRED.`);
else if (gas === 0n) console.log(`\n⚠️  Agent EOA has no gas. Fund it with a little ETH on Arbitrum.`);
else console.log(`\n✅ Ready to send.`);
