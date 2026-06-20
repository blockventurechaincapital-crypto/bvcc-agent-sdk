/**
 * Read the wallet's native + token balances (read-only).
 *   set -a; . ./.env; set +a; npx tsx examples/10-balances.ts
 */
import { BvccAgentClient } from "../src/index.js";

const c = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: Number(process.env.CHAIN_ID ?? 42161),
  rpcUrl: process.env.RPC_URL,
});

const native = await c.getNativeBalance();
console.log(`${native.symbol}: ${native.formatted}`);

// Accepts symbols (from the registry) or addresses.
const balances = await c.getBalances(["USDC", "WETH"]);
for (const b of balances) console.log(`${b.symbol}: ${b.formatted}  (${b.raw} raw)`);
