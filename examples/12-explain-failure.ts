/**
 * Explain a failed transaction. Two ways:
 *  (a) decode a known revert (offline) via explainFailure / decodeRevert
 *  (b) dry-run an over-limit action and read the structured failure
 *   set -a; . ./.env; set +a; npx tsx examples/12-explain-failure.ts
 */
import { BvccAgentClient, decodeRevert, parseEther } from "../src/index.js";
import { toFunctionSelector } from "viem";

// (a) Offline: decode raw revert data into a human message.
const decoded = decodeRevert({ data: toFunctionSelector("DailyLimitExceeded()") });
console.log("offline decode:", decoded);

// (b) Live: dry-run a deliberately huge native send and explain the failure.
const c = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: Number(process.env.CHAIN_ID ?? 42161),
  rpcUrl: process.env.RPC_URL,
});

const r = await c.dryRunSendNative(c.walletAddress, parseEther("1000000"));
if (!r.ok && r.failure) {
  console.log("\nlive dry-run failure:");
  console.log("  errorName:", r.failure.errorName);
  console.log("  human:", r.failure.humanMessage);
  console.log("  suggested:", r.failure.suggestedAction);
} else {
  console.log("\n(dry-run unexpectedly ok)");
}
