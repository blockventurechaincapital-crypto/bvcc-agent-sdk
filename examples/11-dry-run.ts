/**
 * Dry-run a token send and a v4 swap (simulate + estimate gas, no broadcast).
 *   set -a; . ./.env; set +a; npx tsx examples/11-dry-run.ts
 */
import { BvccAgentClient, formatEther, parseUnits, resolveToken } from "../src/index.js";

const c = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: 42161,
  rpcUrl: process.env.RPC_URL,
});

const USDC = resolveToken(42161, "USDC").address;
const WETH = resolveToken(42161, "WETH").address;

const send = await c.dryRunSendToken(USDC, c.walletAddress, parseUnits("0.05", 6));
console.log("send token dry-run:", {
  ok: send.ok,
  gas: send.estimatedGas?.toString() ?? null,
  fee: send.estimatedNetworkFeeWei ? `${formatEther(send.estimatedNetworkFeeWei)} ETH` : null,
  failure: send.failure?.humanMessage ?? null,
});

const swap = await c.dryRunSwapV4({
  tokenIn: USDC, tokenOut: WETH, amountIn: parseUnits("0.05", 6),
  amountOutMinimum: 1n, fee: 500, tickSpacing: 10,
});
console.log("v4 swap dry-run:", {
  ok: swap.ok,
  gas: swap.estimatedGas?.toString() ?? null,
  failure: swap.failure?.humanMessage ?? null,
});
