/**
 * Build a swap plan with an optional on-chain quote (read-only, no broadcast).
 *   set -a; . ./.env; set +a; npx tsx examples/13-swap-plan.ts
 */
import { BvccAgentClient, parseUnits } from "../src/index.js";

const c = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: 42161,
  rpcUrl: process.env.RPC_URL,
});

const plan = await c.buildSwapPlan({
  protocol: "v4",
  tokenIn: "USDC",
  tokenOut: "WETH",
  amountIn: parseUnits("0.1", 6),
  fee: 500,
  tickSpacing: 10,
  quote: true,       // quote on-chain to fill amountOutMinimum
  slippageBps: 50,   // 0.5%
});

console.log({
  protocol: plan.protocol,
  amountIn: plan.amountIn.toString(),
  amountOutMinimum: plan.amountOutMinimum?.toString() ?? null,
  needsApproval: plan.needsApproval,
  requiredProtocols: plan.requiredProtocols,
  requiredTokens: plan.requiredTokens,
});
if (plan.warnings.length) console.log("warnings:\n  - " + plan.warnings.join("\n  - "));
