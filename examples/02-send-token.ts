/**
 * Send an ERC-20 token from a BVCC Agent Wallet, as the agent.
 *
 *   AGENT_PRIVATE_KEY=0x...  WALLET_ADDRESS=0x...  CHAIN_ID=42161 \
 *   TOKEN=0x...  TO=0x...  AMOUNT=10  tsx examples/02-send-token.ts
 */
import { BvccAgentClient, parseUnits } from "../src/index.js";

const client = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: Number(process.env.CHAIN_ID ?? 42161),
});

const token = process.env.TOKEN as `0x${string}`;
const to = process.env.TO as `0x${string}`;
// USDC has 6 decimals; adjust per token.
const amount = parseUnits(process.env.AMOUNT ?? "10", 6);

const check = await client.canSpendToken(token, amount);
if (!check.ok) {
  console.error("Blocked by limits:", check.reason);
  process.exit(1);
}

const receipt = await client.executeAndWait([client.buildSendToken(token, to, amount)]);
console.log(`Sent. status=${receipt.status} tx=${receipt.transactionHash}`);
