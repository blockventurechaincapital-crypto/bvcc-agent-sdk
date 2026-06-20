/**
 * Send native currency (ETH/BNB) from a BVCC Agent Wallet, as the agent.
 *
 *   AGENT_PRIVATE_KEY=0x...  WALLET_ADDRESS=0x...  CHAIN_ID=421614  tsx examples/01-send-native.ts
 */
import { BvccAgentClient, parseEther } from "../src/index.js";

const client = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: Number(process.env.CHAIN_ID ?? 421614),
});

const to = "0x7f71364c210912c2d3aAE2A3F68D6d6554F0a087";
const amount = parseEther("0.0007");

// Preflight against the on-chain limits — avoids paying gas for a revert.
const check = await client.canSpendNative(amount);
if (!check.ok) {
  console.error("Blocked by limits:", check.reason);
  process.exit(1);
}

const receipt = await client.executeAndWait([client.buildSendNative(to, amount)]);
console.log(`Sent. status=${receipt.status} tx=${receipt.transactionHash}`);
console.log(`${client.network.explorer}/tx/${receipt.transactionHash}`);
