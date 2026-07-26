import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CATALOG,
  capabilitiesByKind,
  getCapability,
  filterByModules,
  type CapabilityKind,
} from "../src/catalog.js";

describe("capability catalog", () => {
  it("is non-empty", () => {
    expect(CATALOG.length).toBeGreaterThan(0);
  });

  it("has unique ids", () => {
    const ids = CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry is well-formed (kind, text, zod params, invoke)", () => {
    const kinds: CapabilityKind[] = ["read", "write", "simulate"];
    for (const c of CATALOG) {
      expect(kinds).toContain(c.kind);
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.summary.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
      expect(c.params).toBeInstanceOf(z.ZodType);
      expect(typeof c.invoke).toBe("function");
    }
  });

  it("getCapability finds by id and returns undefined otherwise", () => {
    expect(getCapability("sendToken")?.id).toBe("sendToken");
    expect(getCapability("doesNotExist")).toBeUndefined();
  });

  it("capabilitiesByKind partitions the catalog", () => {
    const total =
      capabilitiesByKind("read").length +
      capabilitiesByKind("write").length +
      capabilitiesByKind("simulate").length;
    expect(total).toBe(CATALOG.length);
  });

  it("write actions that move funds are present", () => {
    const writes = capabilitiesByKind("write").map((c) => c.id);
    expect(writes).toEqual(
      expect.arrayContaining(["sendNative", "sendToken", "approve", "swapV3", "swapV4"]),
    );
  });

  it("validates args through the zod schema (sendToken)", () => {
    const send = getCapability("sendToken")!;
    const good = send.params.safeParse({
      token: "USDC",
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      amount: "0.5",
    });
    expect(good.success).toBe(true);

    const badAddr = send.params.safeParse({ token: "USDC", to: "not-an-address", amount: "0.5" });
    expect(badAddr.success).toBe(false);

    const badAmount = send.params.safeParse({
      token: "USDC",
      to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      amount: "abc",
    });
    expect(badAmount.success).toBe(false);
  });

  it("write swaps refuse amountOutMinimum 0 (slippage guard)", async () => {
    // Stub client: USDC/WBTC decimals come from the registry, so no RPC is hit
    // before the guard throws.
    const stub = { network: { chainId: 42161 } } as never;
    for (const id of ["swapV3", "swapV4"]) {
      const cap = getCapability(id)!;
      await expect(
        cap.invoke(stub, {
          tokenIn: "USDC",
          tokenOut: "WBTC",
          amountIn: "0.1",
          amountOutMinimum: "0",
        } as never),
      ).rejects.toThrow(/slippage/i);
    }
  });

  it("write swaps refuse when neither amountOutMinimum nor slippageBps is given", async () => {
    const stub = { network: { chainId: 42161 } } as never;
    for (const id of ["swapV3", "swapV4"]) {
      const cap = getCapability(id)!;
      await expect(
        cap.invoke(stub, { tokenIn: "USDC", tokenOut: "WBTC", amountIn: "0.1" } as never),
      ).rejects.toThrow(/slippage|amountOutMinimum|slippageBps/i);
    }
  });

  it("swap params accept slippageBps and optional amountOutMinimum", () => {
    const swap = getCapability("swapV4")!;
    expect(
      swap.params.safeParse({ tokenIn: "USDC", tokenOut: "WBTC", amountIn: "0.1", slippageBps: 100 })
        .success,
    ).toBe(true);
  });

  it("read capabilities take no required params", () => {
    const status = getCapability("getAgentStatus")!;
    expect(status.kind).toBe("read");
    expect(status.params.safeParse({}).success).toBe(true);
  });
});

describe("capability modules (BVCC_MCP_MODULES)", () => {
  it("labels every Aave capability so it can be switched off as a group", () => {
    const aave = CATALOG.filter((c) => /^(aave|getAave|dryRunAave)/.test(c.id));
    expect(aave.length).toBeGreaterThan(0);
    for (const c of aave) expect(c.module).toBe("aave");
  });

  it("treats an unlabelled capability as core", () => {
    const core = CATALOG.filter((c) => (c.module ?? "core") === "core");
    expect(core.some((c) => c.id === "sendNative")).toBe(true);
    expect(core.some((c) => c.id.startsWith("aave"))).toBe(false);
  });

  it("returns everything when no modules are requested", () => {
    expect(filterByModules(CATALOG, []).length).toBe(CATALOG.length);
  });

  it("drops the whole Aave surface with modules=core", () => {
    const only = filterByModules(CATALOG, ["core"]);
    expect(only.length).toBeLessThan(CATALOG.length);
    expect(only.some((c) => c.module === "aave")).toBe(false);
  });

  it("keeps only lending (plus the always-on meta guides) with modules=aave", () => {
    const only = filterByModules(CATALOG, ["aave"]);
    expect(only.every((c) => c.module === "aave" || c.module === "meta")).toBe(true);
    expect(only.some((c) => c.module === "aave")).toBe(true);
  });

  it("is case- and whitespace-tolerant", () => {
    expect(filterByModules(CATALOG, [" AAVE "]).length).toBe(filterByModules(CATALOG, ["aave"]).length);
  });

  it("degrades to a SMALLER surface on an unknown module, never a larger one", () => {
    // A typo must not silently expose more than asked — only the always-on meta
    // help (guides) survives, never a feature surface.
    const only = filterByModules(CATALOG, ["lending"]);
    expect(only.length).toBeLessThan(CATALOG.length);
    expect(only.every((c) => c.module === "meta")).toBe(true);
  });
});
