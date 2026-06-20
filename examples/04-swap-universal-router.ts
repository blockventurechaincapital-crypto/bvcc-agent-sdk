/**
 * Swap via Uniswap Universal Router (aligned with the BVCC frontend's router).
 *
 *   AGENT_PRIVATE_KEY=0x...  WALLET_ADDRESS=0x...  CHAIN_ID=42161 \
 *   tsx examples/04-swap-universal-router.ts
 *
 * Requires the Universal Router in the agent's allowedProtocols, and tokenIn in
 * allowedTokens. Quote amountOutMinimum yourself before running.
 */
import { BvccAgentClient } from "../src/index.js";

const client = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: Number(process.env.CHAIN_ID ?? 42161),
});

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // Arbitrum One USDC
const WETH = client.network.weth!;

// token → token (10 USDC → WETH)
const batch = client.buildSwapViaUniversalRouter({
  tokenIn: USDC,
  tokenOut: WETH,
  amountIn: 10_000_000n,
  amountOutMinimum: 1n, // set a real min from a quote in production
  fee: 500,
});

const check = await client.canSpendToken(USDC, 10_000_000n);
if (!check.ok) {
  console.error("Blocked by limits:", check.reason);
  process.exit(1);
}

const receipt = await client.executeAndWait(batch);
console.log(`Swap status=${receipt.status} tx=${receipt.transactionHash}`);

// native → token would be: { tokenIn: WETH, tokenOut: USDC, amountIn, amountOutMinimum, nativeIn: true }
// token → native would be: { tokenIn: USDC, tokenOut: WETH, amountIn, amountOutMinimum, nativeOut: true }
