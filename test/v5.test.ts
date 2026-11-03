import { describe, expect, it } from "vitest";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  toFunctionSelector,
  type Address,
} from "viem";

import {
  adaptBatchForV5,
  remainingUnder,
  UINT128_MAX,
  V5UnsupportedError,
  withAgentFee,
} from "../src/v5.js";
import { decodeRevert } from "../src/errors.js";
import { swapRouter02Abi, erc20Abi } from "../src/abi.js";
import { PERMIT2, buildUniversalRouterSwap } from "../src/universalRouter.js";
import type { Execution } from "../src/types.js";

const WALLET = "0x39D7cD2964A7E7a32585017dca81f2ccf90F967A" as Address;
const UR = "0xeFd1D4bD4cf1e86Da286BB4CB1B8BcED9C10BA47" as Address;
const SR02 = "0x101F443B4d1b059569D643917553c771E1b9663E" as Address;
const NFPM = "0x6b2937Bde17889EDCf8fbD8dE31C3C2a70Bc4d65" as Address;
const WETH = "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73" as Address;
const USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as Address;
const OTHER = "0x000000000000000000000000000000000000dEaD" as Address;
const ctx = { wallet: WALLET, universalRouter: UR, swapRouter02: SR02, nfpm: NFPM, weth: WETH, now: 1_000n };

const urAbi = [
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

const approve = (token: Address, spender: Address, amount: bigint): Execution => ({
  target: token,
  value: 0n,
  callData: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
});

const sr02Single = (recipient: Address): Execution => ({
  target: SR02,
  value: 0n,
  callData: encodeFunctionData({
    abi: swapRouter02Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: USDC,
        tokenOut: WETH,
        fee: 10000,
        recipient,
        amountIn: 500_000n,
        amountOutMinimum: 7n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  }),
});

const v3Input = [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }] as const;

describe("V5 limits", () => {
  it("reads 0 as nothing and uint128 max as unlimited", () => {
    expect(remainingUnder(0n, 0n, true)).toBe(0n);
    expect(remainingUnder(UINT128_MAX, 5n, true)).toBeNull();
    expect(remainingUnder(10n, 3n, true)).toBe(7n);
    expect(remainingUnder(10n, 30n, true)).toBe(0n);
  });
  it("keeps the old meaning before V5", () => {
    expect(remainingUnder(0n, 0n, false)).toBeNull();
    expect(remainingUnder(10n, 3n, false)).toBe(7n);
  });
  it("adds the 0.15% agent fee, rounded down", () => {
    expect(withAgentFee(20_000_000_000_000_000n)).toBe(20_030_000_000_000_000n);
    expect(withAgentFee(1n)).toBe(1n);
  });
});

describe("adaptBatchForV5", () => {
  it("drops the agent's own Permit2 grants from a Universal Router swap", () => {
    const batch = buildUniversalRouterSwap({
      router: UR,
      recipient: WALLET,
      tokenIn: USDC,
      tokenOut: WETH,
      amountIn: 500_000n,
      amountOutMinimum: 1n,
      fee: 10000,
    } as Parameters<typeof buildUniversalRouterSwap>[0]);
    expect(batch.some((e) => e.target.toLowerCase() === PERMIT2.toLowerCase())).toBe(true);
    const out = adaptBatchForV5(batch, ctx);
    expect(out).toHaveLength(1);
    expect(out[0].target).toBe(UR);
  });

  it("routes a SwapRouter02 exactInputSingle through the Universal Router", () => {
    const out = adaptBatchForV5([approve(USDC, SR02, 500_000n), sr02Single(WALLET)], ctx);
    expect(out).toHaveLength(1);
    expect(out[0].target).toBe(UR);
    const { args } = decodeFunctionData({ abi: urAbi, data: out[0].callData });
    expect(args[0]).toBe("0x00");
    expect(args[2]).toBe(1_000n + 1_200n);
    const [recipient, amountIn, minOut, path, payerIsUser] = decodeAbiParameters(v3Input, args[1][0]);
    expect(recipient).toBe(WALLET);
    expect(amountIn).toBe(500_000n);
    expect(minOut).toBe(7n);
    expect(path).toBe(encodePacked(["address", "uint24", "address"], [USDC, 10000, WETH]).toLowerCase());
    expect(payerIsUser).toBe(true);
  });

  it("refuses a SwapRouter02 swap whose output leaves the wallet", () => {
    expect(() => adaptBatchForV5([sr02Single(OTHER)], ctx)).toThrow(V5UnsupportedError);
  });

  it("refuses wrapping, Uniswap v3 liquidity and repayWithATokens", () => {
    const deposit: Execution = { target: WETH, value: 1n, callData: "0xd0e30db0" };
    const nfpm: Execution = { target: NFPM, value: 0n, callData: "0x12345678" };
    const aTokens: Execution = { target: OTHER, value: 0n, callData: "0x2dad97d4" };
    for (const e of [deposit, nfpm, aTokens]) expect(() => adaptBatchForV5([e], ctx)).toThrow(V5UnsupportedError);
  });

  it("leaves plain sends, approvals to other spenders and unknown calls alone", () => {
    const send: Execution = { target: OTHER, value: 5n, callData: "0x" };
    const aaveApprove = approve(USDC, OTHER, 1n);
    expect(adaptBatchForV5([send, aaveApprove], ctx)).toEqual([send, aaveApprove]);
  });
});

describe("V5 error decoding", () => {
  it("returns the SDK's own explanation for a V5 refusal", () => {
    const d = decodeRevert(new V5UnsupportedError("not here", "do this"));
    expect(d.errorName).toBe("V5Unsupported");
    expect(d.humanMessage).toBe("not here");
    expect(d.suggestedAction).toBe("do this");
  });
  it("names the new contract errors", () => {
    for (const name of ["AgentPaused", "TargetIsBlocked", "PostCheckFailed", "UnsupportedExecutionMode"]) {
      const d = decodeRevert({ data: toFunctionSelector(`${name}()`) });
      expect(d.errorName).toBe(name);
    }
  });
  it("names Permit2's allowance errors, which carry an argument", () => {
    const data = (toFunctionSelector("AllowanceExpired(uint256)") + "0".repeat(64)) as `0x${string}`;
    expect(decodeRevert({ data }).errorName).toBe("AllowanceExpired");
  });
});

describe("V5 with the new validators active", () => {
  const active = { ...ctx, v3LiquidityActive: true, wrapActive: true };
  it("lets wrap / unwrap and Uniswap v3 liquidity through where active", () => {
    const deposit: Execution = { target: WETH, value: 1n, callData: "0xd0e30db0" };
    const nfpm: Execution = { target: NFPM, value: 0n, callData: "0x88316456" };
    expect(adaptBatchForV5([deposit, nfpm], active)).toEqual([deposit, nfpm]);
  });
  it("still refuses them where inactive, and repayWithATokens everywhere", () => {
    const aTokens: Execution = { target: OTHER, value: 0n, callData: "0x2dad97d4" };
    expect(() => adaptBatchForV5([aTokens], active)).toThrow(V5UnsupportedError);
    expect(() => adaptBatchForV5([{ target: WETH, value: 1n, callData: "0xd0e30db0" }], ctx)).toThrow(V5UnsupportedError);
  });
});
