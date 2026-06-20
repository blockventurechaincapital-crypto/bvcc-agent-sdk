/**
 * Read the agent's status and capabilities (read-only).
 *   set -a; . ./.env; set +a; npx tsx examples/09-agent-status.ts
 */
import { BvccAgentClient } from "../src/index.js";

const c = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: Number(process.env.CHAIN_ID ?? 42161),
  rpcUrl: process.env.RPC_URL,
});

const status = await c.getAgentStatus();
console.log("Status:", {
  ...status,
  expiry: status.expiry.toString(),
  allowedTokens: [...status.allowedTokens],
  allowedProtocols: [...status.allowedProtocols],
});

const caps = await c.getCapabilities();
console.log("\nCapabilities:", {
  canSendNative: caps.canSendNative,
  canSendTokens: caps.canSendTokens,
  canSwapV3: caps.canSwapV3,
  canSwapV4: caps.canSwapV4,
});
if (caps.notes.length) console.log("Notes:\n  - " + caps.notes.join("\n  - "));
