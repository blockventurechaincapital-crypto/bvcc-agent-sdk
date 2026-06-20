/**
 * One-off native send with full preflight (limits + recipient whitelist).
 *   set -a; . ./.env; set +a; TO=0x... AMOUNT_ETH=0.0001 npx tsx examples/05-send-to.ts
 */
import { BvccAgentClient, parseEther, formatEther } from "../src/index.js";

const client = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: Number(process.env.CHAIN_ID ?? 42161),
  rpcUrl: process.env.RPC_URL,
});

const to = process.env.TO as `0x${string}`;
const amount = parseEther(process.env.AMOUNT_ETH ?? "0.0001");
const cur = client.network.currency;

console.log(`Sending ${formatEther(amount)} ${cur} → ${to}`);

// Limit preflight.
const check = await client.canSpendNative(amount);
if (!check.ok) throw new Error(`Blocked by limits: ${check.reason}`);

// Recipient whitelist preflight (empty list = any recipient allowed).
const perm = await client.getPermission();
if (perm.allowedRecipients.length > 0) {
  const allowed = perm.allowedRecipients.some((a) => a.toLowerCase() === to.toLowerCase());
  if (!allowed) {
    console.log(`allowedRecipients: ${perm.allowedRecipients.join(", ")}`);
    throw new Error(`Recipient ${to} is NOT in the agent's allowedRecipients whitelist — would revert.`);
  }
  console.log("Recipient is whitelisted ✅");
} else {
  console.log("No recipient whitelist (any recipient allowed).");
}

console.log("Broadcasting…");
const receipt = await client.executeAndWait([client.buildSendNative(to, amount)]);
console.log(`status=${receipt.status}  gasUsed=${receipt.gasUsed}`);
console.log(`tx: ${client.network.explorer}/tx/${receipt.transactionHash}`);
