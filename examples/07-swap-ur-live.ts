/**
 * Real USDC -> WETH swap via Universal Router + Permit2 (V3_SWAP_EXACT_IN).
 *   set -a; . ./.env; set +a; AMOUNT_USDC=0.1 npx tsx examples/07-swap-ur-live.ts
 */
import { BvccAgentClient, parseUnits, formatEther } from "../src/index.js";

const client = new BvccAgentClient({
  account: process.env.AGENT_PRIVATE_KEY as `0x${string}`,
  walletAddress: process.env.WALLET_ADDRESS as `0x${string}`,
  network: 42161,
  rpcUrl: process.env.RPC_URL,
});

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const WETH = client.network.weth!;
const QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as const; // v3 QuoterV2
const amountIn = parseUnits(process.env.AMOUNT_USDC ?? "0.1", 6);

const quoterAbi = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "p", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" },
    { name: "sqrtPriceLimitX96", type: "uint160" }]}],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "a", type: "uint160" },
    { name: "b", type: "uint32" }, { name: "c", type: "uint256" }],
}] as const;

let best: { fee: number; out: bigint } | null = null;
for (const fee of [500, 3000, 100, 10000]) {
  try {
    const { result } = await client.publicClient.simulateContract({
      address: QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ tokenIn: USDC, tokenOut: WETH, amountIn, fee, sqrtPriceLimitX96: 0n }],
    });
    const out = result[0] as bigint;
    if (out > 0n && (!best || out > best.out)) best = { fee, out };
  } catch { /* no pool */ }
}
if (!best) throw new Error("No pool with liquidity for USDC/WETH");

const amountOutMinimum = (best.out * 99n) / 100n; // 1% slippage
console.log(`UR swap ${process.env.AMOUNT_USDC ?? "0.1"} USDC -> WETH @ fee ${best.fee}`);
console.log(`  quoted: ${formatEther(best.out)} WETH | min: ${formatEther(amountOutMinimum)} WETH`);
console.log(`  router: ${client.network.universalRouter}`);

const pre = await client.canSpendToken(USDC, amountIn);
if (!pre.ok) throw new Error(`Blocked: ${pre.reason}`);

const batch = client.buildSwapViaUniversalRouter({
  tokenIn: USDC, tokenOut: WETH, amountIn, amountOutMinimum, fee: best.fee,
});
console.log(`  batch items: ${batch.length} (approve->Permit2, Permit2.approve, UR.execute)`);
console.log("Broadcasting…");
const receipt = await client.executeAndWait(batch);
console.log(`status=${receipt.status}  gasUsed=${receipt.gasUsed}`);
console.log(`tx: ${client.network.explorer}/tx/${receipt.transactionHash}`);
