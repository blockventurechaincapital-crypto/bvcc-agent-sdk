/**
 * Print the agent's live remaining budget across every on-chain limit.
 * Useful for an agent to plan actions before attempting them.
 *
 *   AGENT_PRIVATE_KEY=0x...  WALLET_ADDRESS=0x...  CHAIN_ID=42161  tsx examples/03-read-limits.ts
 */
import { BvccAgentClient, formatEther } from "../src/index.js";

const client = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: Number(process.env.CHAIN_ID ?? 42161),
});

const fmt = (v: bigint | null) => (v === null ? "unlimited" : `${formatEther(v)} ${client.network.currency}`);

const r = await client.getRemaining();
console.log(`Agent ${client.agentAddress} on ${client.network.name}`);
console.log(`  active=${r.active} expired=${r.expired}`);
console.log(`  per-tx max:        ${fmt(r.maxPerTxWei)}`);
console.log(`  daily remaining:   ${fmt(r.dailyRemainingWei)}`);
console.log(`  period remaining:  ${fmt(r.periodRemainingWei)}`);
console.log(`  lifetime remaining:${fmt(r.totalRemainingWei)}`);
if (r.periodResetsInSeconds !== null) {
  console.log(`  period resets in:  ${r.periodResetsInSeconds}s`);
}
for (const t of r.tokens) {
  console.log(`  token ${t.token}`);
  console.log(`    daily remaining: ${t.dailyRemaining === null ? "unlimited" : t.dailyRemaining}`);
  console.log(`    total remaining: ${t.totalRemaining === null ? "unlimited" : t.totalRemaining}`);
}
