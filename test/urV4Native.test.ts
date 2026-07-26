import { describe, it, expect } from "vitest";
import { decodeFunctionData, decodeAbiParameters, parseAbiParameters } from "viem";
import { buildV4SwapExactIn } from "../src/index.js";

/**
 * Native-output v4 swap = the native (address(0)) pool + a TAKE straight to the
 * wallet. NO WETH, NO UNWRAP_WETH command, NO ADDRESS_THIS. This is what keeps
 * the calldata inside BVCCUniversalRouterValidator's rule (every output lands in
 * the wallet — nothing parked in the router to be swept). If any of these change,
 * the on-chain validator would reject the agent's native swap.
 */

const URROUTER_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const WALLET = "0x000000000000000000000000000000000000cafe";
const NATIVE = "0x0000000000000000000000000000000000000000";
const V4_INPUT_T = parseAbiParameters("bytes actions, bytes[] params");
const TAKE_T = parseAbiParameters("address currency, address recipient, uint256 amount");
const EXACT_IN_T = parseAbiParameters(
  "(address currencyIn, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint128 amountIn, uint128 amountOutMinimum)",
);

const execs = buildV4SwapExactIn({
  router: "0x8b844f885672f333bc0042cb669255f93a4c1e6b",
  tokenIn: "0x00000000000000000000000000000000000000a1",
  tokenOut: "0x00000000000000000000000000000000000000b2", // ignored for native
  amountIn: 1000000n,
  amountOutMinimum: 990000n,
  fee: 500,
  tickSpacing: 10,
  recipient: WALLET,
  nativeOut: true,
  deadline: 1893456000n,
});
const exec = execs[execs.length - 1];
const { args } = decodeFunctionData({ abi: URROUTER_ABI, data: exec.callData });
const [commands, inputs] = args as unknown as [`0x${string}`, `0x${string}`[], bigint];
const [, params] = decodeAbiParameters(V4_INPUT_T, inputs[0]);
const paramArr = params as `0x${string}`[];

describe("v4 native-out swap (native pool, no unwrap)", () => {
  it("emits exactly ONE command: V4_SWAP (0x10) — no UNWRAP_WETH (0x0c)", () => {
    expect(commands).toBe("0x10");
    expect(inputs.length).toBe(1);
  });

  it("v4 actions are SWAP_EXACT_IN + SETTLE + TAKE (07 0b 0e)", () => {
    const [actions] = decodeAbiParameters(V4_INPUT_T, inputs[0]);
    expect(actions).toBe("0x070b0e");
  });

  it("TAKE delivers native (address(0)) straight to the wallet", () => {
    const [currency, recipient] = decodeAbiParameters(TAKE_T, paramArr[2]);
    expect((currency as string).toLowerCase()).toBe(NATIVE);
    expect((recipient as string).toLowerCase()).toBe(WALLET);
  });

  it("the real slippage floor lives on the swap (not zeroed)", () => {
    const [swap] = decodeAbiParameters(EXACT_IN_T, paramArr[0]);
    expect((swap as { amountOutMinimum: bigint }).amountOutMinimum).toBe(990000n);
    // and the path's output currency is native too
    expect(
      (swap as { path: { intermediateCurrency: string }[] }).path[0].intermediateCurrency.toLowerCase(),
    ).toBe(NATIVE);
  });
});
