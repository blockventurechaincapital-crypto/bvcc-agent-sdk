import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";

import { BvccAgentClient } from "../src/client.js";
import { buildNativeToToken, buildTokenToNative, SameTokenSwapError } from "../src/nativeSwap.js";
import type { Execution } from "../src/types.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const WALLET = "0x56ac9854536155d6eE8719203F52AeCF70de7f41" as const;
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as const; // Arbitrum One
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as const;
const ONE = 10n ** 18n;

const wethAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] },
] as const;

const isDeposit = (e: Execution, value: bigint) =>
  e.target.toLowerCase() === WETH.toLowerCase() && e.value === value && e.callData === "0xd0e30db0";
const withdrawAmount = (e: Execution) => {
  const d = decodeFunctionData({ abi: wethAbi, data: e.callData as Hex });
  expect(d.functionName).toBe("withdraw");
  return d.args?.[0] as bigint;
};

/** A client whose chain reads and sends are stubbed: sent batches are captured, nothing leaves. */
function client(version: "v4" | "v5") {
  const c = new BvccAgentClient({ network: 42161, account: KEY, walletAddress: WALLET, updateCheck: false });
  vi.spyOn(c, "walletVersion").mockResolvedValue(version);
  vi.spyOn(c, "maxSpendable").mockResolvedValue(1000n * ONE);
  const sent: Execution[][] = [];
  // run() sends through executeNow and then waits for the receipt: stub both.
  vi.spyOn(c as never, "executeNow").mockImplementation((async (ex: Execution[]) => {
    sent.push(ex);
    return "0xabc" as Hex;
  }) as never);
  vi.spyOn(c.publicClient, "waitForTransactionReceipt").mockResolvedValue({ status: "success" } as never);
  return { c, sent };
}

afterEach(() => vi.restoreAllMocks());

describe("pure builders: ETH ↔ WETH is a wrap, not a swap", () => {
  it("buildNativeToToken with tokenOut = WETH is a single deposit (V4 and V5 fee models)", () => {
    for (const feeOnTop of [false, true]) {
      const ex = buildNativeToToken({ router: ROUTER, wallet: WALLET, weth: WETH, tokenOut: WETH, amountIn: 97n * ONE / 100n, amountOutMinimum: 1n, feeOnTop });
      expect(ex).toHaveLength(1);
      expect(isDeposit(ex[0], 97n * ONE / 100n)).toBe(true);
    }
  });

  it("buildTokenToNative with tokenIn = WETH is a single withdraw of amountOut", () => {
    const ex = buildTokenToNative({ router: ROUTER, wallet: WALLET, weth: WETH, tokenIn: WETH.toLowerCase() as Address, amountOut: ONE / 2n, amountInMaximum: ONE });
    expect(ex).toHaveLength(1);
    expect(ex[0].value).toBe(0n);
    expect(withdrawAmount(ex[0])).toBe(ONE / 2n);
  });

  it("other tokens still build approve + swap", () => {
    expect(buildNativeToToken({ router: ROUTER, wallet: WALLET, weth: WETH, tokenOut: USDC, amountIn: ONE, amountOutMinimum: 1n })).toHaveLength(3);
    expect(buildTokenToNative({ router: ROUTER, wallet: WALLET, weth: WETH, tokenIn: USDC, amountOut: ONE, amountInMaximum: 1n })).toHaveLength(3);
  });
});

describe("client.wrapNative / unwrapNative", () => {
  it("wrapNative sends [WETH.deposit{value}] on V4 and on V5", async () => {
    for (const v of ["v4", "v5"] as const) {
      const { c, sent } = client(v);
      const r = await c.wrapNative(ONE / 100n);
      expect(r.ok).toBe(true);
      expect(r.action).toBe("wrapNative");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toHaveLength(1);
      expect(isDeposit(sent[0][0], ONE / 100n)).toBe(true);
      vi.restoreAllMocks();
    }
  });

  it("unwrapNative sends [WETH.withdraw(amount)]", async () => {
    const { c, sent } = client("v5");
    const r = await c.unwrapNative(ONE / 100n);
    expect(r.ok).toBe(true);
    expect(sent[0]).toHaveLength(1);
    expect(withdrawAmount(sent[0][0])).toBe(ONE / 100n);
  });

  it("on V5, a wrap with no room for the fee on top is refused before any gas", async () => {
    const { c, sent } = client("v5");
    vi.spyOn(c, "maxSpendable").mockResolvedValue(ONE / 1000n);
    vi.spyOn(c, "getNativeBalance").mockResolvedValue({ raw: ONE / 100n, decimals: 18, symbol: "ETH" } as never);
    const r = await c.wrapNative(ONE / 100n);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorName).toBe("NoRoomForFee");
      expect(r.retryable).toBe(false);
    }
    expect(sent).toHaveLength(0);
  });
});

describe("swapFromNative / swapToNative delegate to wrap / unwrap", () => {
  it("swapFromNative(tokenOut = WETH) is exactly the reported failing case, now a single deposit", async () => {
    // The 5 Nov transactions: 0.9703 ETH → WETH built deposit + approve + WETH→WETH swap and reverted.
    for (const v of ["v4", "v5"] as const) {
      const { c, sent } = client(v);
      const amountIn = 9703n * ONE / 10000n;
      const r = await c.swapFromNative({ tokenOut: WETH, amountIn, amountOutMinimum: 965n * ONE / 1000n });
      expect(r.ok).toBe(true);
      expect(r.action).toBe("wrapNative");
      expect(sent[0]).toHaveLength(1);
      expect(isDeposit(sent[0][0], amountIn)).toBe(true);
      vi.restoreAllMocks();
    }
  });

  it("swapToNative(tokenIn = WETH) is a single withdraw", async () => {
    const { c, sent } = client("v4");
    const r = await c.swapToNative({ tokenIn: WETH, amountOut: ONE / 10n, amountInMaximum: ONE });
    expect(r.ok).toBe(true);
    expect(r.action).toBe("unwrapNative");
    expect(sent[0]).toHaveLength(1);
    expect(withdrawAmount(sent[0][0])).toBe(ONE / 10n);
  });
});

describe("single-hop swap from a token to itself is refused", () => {
  it("swapV3 WETH → WETH: failed result, not retryable, nothing sent", async () => {
    const { c, sent } = client("v4");
    const r = await c.swapExactInputV3({ tokenIn: WETH, tokenOut: WETH, amountIn: ONE, amountOutMinimum: 1n });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorName).toBe("SameTokenSwap");
      expect(r.retryable).toBe(false);
      expect(r.suggestedAction).toMatch(/wrapNative/);
    }
    expect(sent).toHaveLength(0);
  });

  it("swapV4: same token and WETH → native ETH (single hop) are refused", async () => {
    const { c, sent } = client("v4");
    const same = await c.swapV4ExactIn({ tokenIn: USDC, tokenOut: USDC, amountIn: 1_000_000n, amountOutMinimum: 1n, fee: 500, tickSpacing: 10 });
    expect(same.ok).toBe(false);
    const toNative = await c.swapV4ExactIn({ tokenIn: WETH, tokenOut: WETH, amountIn: ONE, amountOutMinimum: 1n, fee: 500, tickSpacing: 10, nativeOut: true });
    expect(toNative.ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("a multi-hop route that comes back to its start (arbitrage) is still built", () => {
    const { c } = client("v4");
    const ex = c.buildSwapV4ExactIn({
      tokenIn: WETH,
      tokenOut: WETH,
      amountIn: ONE,
      amountOutMinimum: 1n,
      path: [
        { intermediateCurrency: USDC, fee: 500, tickSpacing: 10 },
        { intermediateCurrency: WETH, fee: 3000, tickSpacing: 60 },
      ],
    });
    expect(ex.length).toBeGreaterThan(0);
  });

  it("the pure builder throws SameTokenSwapError; dry-runs and the plan refuse it too", async () => {
    const { c } = client("v4");
    expect(() => c.buildSwapExactInputV3({ tokenIn: USDC, tokenOut: USDC, amountIn: 1n, amountOutMinimum: 1n })).toThrow(SameTokenSwapError);
    const dry = await c.dryRunSwapV3({ tokenIn: WETH, tokenOut: WETH, amountIn: ONE, amountOutMinimum: 1n });
    expect(dry.ok).toBe(false);
    expect(dry.failure?.errorName).toBe("SameTokenSwap");
    await expect(c.buildSwapPlan({ protocol: "v3", tokenIn: "WETH", tokenOut: WETH, amountIn: ONE })).rejects.toThrow(SameTokenSwapError);
  });
});

describe("MCP tools (catalog) take the same paths without asking for a quote", async () => {
  const { getCapability } = await import("../src/catalog.js");

  it("swapFromNative tool with tokenOut 'WETH' wraps, with no quote and no minimum", async () => {
    const { c, sent } = client("v4");
    const quote = vi.spyOn(c, "buildSwapPlan");
    const r = (await getCapability("swapFromNative")!.invoke(c, { tokenOut: "WETH", amountIn: "0.9703", slippageBps: 50 } as never)) as { ok: boolean; action: string };
    expect(r.ok).toBe(true);
    expect(r.action).toBe("wrapNative");
    expect(quote).not.toHaveBeenCalled();
    expect(isDeposit(sent[0][0], 9703n * ONE / 10000n)).toBe(true);
  });

  it("swapV3 tool WETH → WETH returns the clear failure, no quote", async () => {
    const { c, sent } = client("v4");
    const quote = vi.spyOn(c, "buildSwapPlan");
    const r = (await getCapability("swapV3")!.invoke(c, { tokenIn: "WETH", tokenOut: "WETH", amountIn: "1", slippageBps: 50 } as never)) as { ok: boolean; errorName?: string; retryable?: boolean };
    expect(r.ok).toBe(false);
    expect(r.errorName).toBe("SameTokenSwap");
    expect(r.retryable).toBe(false);
    expect(quote).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("wrapNative / unwrapNative / dry-run tools exist", () => {
    for (const id of ["wrapNative", "unwrapNative", "dryRunWrapNative", "dryRunUnwrapNative"]) expect(getCapability(id)).toBeTruthy();
  });
});

describe("wallet V5: a v4 swap paying out native ETH is refused before any gas", () => {
  it("swapV4 / dryRunSwapV4 with nativeOut on V5 return V5Unsupported, nothing sent", async () => {
    const { c, sent } = client("v5");
    const p = { tokenIn: USDC, tokenOut: WETH, amountIn: 1_000_000n, amountOutMinimum: 1n, fee: 500, tickSpacing: 10, nativeOut: true };
    const r = await c.swapV4ExactIn(p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorName).toBe("V5Unsupported");
      expect(r.retryable).toBe(false);
      expect(r.suggestedAction).toMatch(/unwrapNative/);
    }
    const d = await c.dryRunSwapV4(p);
    expect(d.ok).toBe(false);
    expect(d.failure?.errorName).toBe("V5Unsupported");
    expect(sent).toHaveLength(0);
  });

  it("on V4 the same nativeOut swap is still built", async () => {
    const { c, sent } = client("v4");
    const r = await c.swapV4ExactIn({ tokenIn: USDC, tokenOut: WETH, amountIn: 1_000_000n, amountOutMinimum: 1n, fee: 500, tickSpacing: 10, nativeOut: true });
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });
});
