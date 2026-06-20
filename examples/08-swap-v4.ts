/**
 * Real Uniswap v4 swap via Universal Router (Permit2), as the agent.
 *   set -a; . ./.env; set +a; AMOUNT_USDC=0.1 npx tsx examples/08-swap-v4.ts
 * Requires Permit2 + the Universal Router in allowedProtocols, and USDC in allowedTokens.
 */
import { BvccAgentClient, parseUnits } from "../src/index.js";
const c = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: 42161, rpcUrl: process.env.RPC_URL,
});
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const WETH = c.network.weth!;
const amountIn = parseUnits(process.env.AMOUNT_USDC ?? "0.1", 6);

const pre = await c.canSpendToken(USDC, amountIn);
if (!pre.ok) throw new Error(`Blocked: ${pre.reason}`);

// USDC/WETH v4 pool on Arbitrum: fee 500, tickSpacing 10, no hooks. Token-out (WETH to wallet).
const batch = c.buildSwapV4ExactIn({
  tokenIn: USDC, tokenOut: WETH, amountIn, amountOutMinimum: 1n, fee: 500, tickSpacing: 10,
});
console.log("Broadcasting v4 swap…");
const r = await c.executeAndWait(batch);
console.log(`status=${r.status} gasUsed=${r.gasUsed}`);
console.log(`tx: ${c.network.explorer}/tx/${r.transactionHash}`);
