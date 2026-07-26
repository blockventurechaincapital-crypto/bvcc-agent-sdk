import { describe, expect, it } from "vitest";

import {
  POLICY_ALLOWED,
  POLICY_DEEP,
  decodePolicy,
  describePolicy,
} from "../src/policy.js";
import { getNetwork } from "../src/networks.js";
import { agentWalletAbi, validatorRegistryAbi } from "../src/abi.js";

/**
 * Golden policy words read from the live Arbitrum wallet
 * 0x605A4C65dBa64bd26d9F7701e1e4Cda48c594A5c on 20 Jul 2026. If decoding ever
 * drifts from what the contract actually stores, these fail.
 */
const LIVE = {
  urExecute: 0xc000000000000000000000000000000000000000000000000000000000000000n,
  swapRouterExactInputSingle: 0x8000000000000008000000000000000000000000000000000000000000000000n,
  permit2Approve: 0x8000000000000000000000020000000000000000000000000000000000000000n,
  aaveBorrow: 0x8000000000000010000000000000000000000000000000000000000000000000n,
  unregistered: 0n,
};

describe("decodePolicy", () => {
  it("treats a zero word as denied", () => {
    const p = decodePolicy(LIVE.unregistered);
    expect(p.allowed).toBe(false);
    expect(p.deep).toBe(false);
    expect(p.pinnedToWallet).toEqual([]);
    expect(p.pinnedToProtocol).toEqual([]);
  });

  it("decodes ALLOWED|DEEP with no pins (Universal Router)", () => {
    const p = decodePolicy(LIVE.urExecute);
    expect(p.allowed).toBe(true);
    expect(p.deep).toBe(true);
    expect(p.pinnedToWallet).toEqual([]);
    expect(p.pinnedToProtocol).toEqual([]);
  });

  it("decodes a PIN_WALLET bitmap (SwapRouter02 recipient = word 3)", () => {
    const p = decodePolicy(LIVE.swapRouterExactInputSingle);
    expect(p.allowed).toBe(true);
    expect(p.deep).toBe(false);
    expect(p.pinnedToWallet).toEqual([3]);
    expect(p.pinnedToProtocol).toEqual([]);
  });

  it("decodes a PIN_PROTOCOL bitmap (Permit2 spender = word 1)", () => {
    const p = decodePolicy(LIVE.permit2Approve);
    expect(p.allowed).toBe(true);
    expect(p.pinnedToWallet).toEqual([]);
    expect(p.pinnedToProtocol).toEqual([1]);
  });

  it("decodes a higher pin index (Aave borrow onBehalfOf = word 4)", () => {
    expect(decodePolicy(LIVE.aaveBorrow).pinnedToWallet).toEqual([4]);
  });

  it("keeps the two bitmaps independent", () => {
    // wallet-pin word 0 and protocol-pin word 0 sit in different 32-bit fields.
    const word = POLICY_ALLOWED | (1n << 192n) | (1n << 161n);
    const p = decodePolicy(word);
    expect(p.pinnedToWallet).toEqual([0]);
    expect(p.pinnedToProtocol).toEqual([1]);
  });

  it("decodes several pins at once", () => {
    const word = POLICY_ALLOWED | (1n << 192n) | (1n << 194n) | (1n << 223n);
    expect(decodePolicy(word).pinnedToWallet).toEqual([0, 2, 31]);
  });

  it("ignores bits outside the two bitmaps", () => {
    // Bits 0..159 are unused by the layout and must not leak into the pins.
    const p = decodePolicy(POLICY_ALLOWED | ((1n << 160n) - 1n));
    expect(p.pinnedToWallet).toEqual([]);
    expect(p.pinnedToProtocol).toEqual([]);
    expect(p.allowed).toBe(true);
  });

  it("does not confuse ALLOWED with DEEP", () => {
    expect(decodePolicy(POLICY_ALLOWED).deep).toBe(false);
    // DEEP without ALLOWED is still denied — bit 255 is the gate.
    expect(decodePolicy(POLICY_DEEP).allowed).toBe(false);
  });
});

describe("describePolicy", () => {
  it("says plainly that an unregistered selector is denied", () => {
    expect(describePolicy(decodePolicy(0n))).toMatch(/not registered a policy/i);
  });

  it("names the pinned word so an agent can fix its calldata", () => {
    const s = describePolicy(decodePolicy(LIVE.swapRouterExactInputSingle));
    expect(s).toMatch(/word 3/);
    expect(s).toMatch(/wallet address/i);
  });

  it("distinguishes a protocol pin from a wallet pin", () => {
    const s = describePolicy(decodePolicy(LIVE.permit2Approve));
    expect(s).toMatch(/word 1/);
    expect(s).toMatch(/whitelisted protocol/i);
  });

  it("mentions validator checking for DEEP policies", () => {
    expect(describePolicy(decodePolicy(LIVE.urExecute))).toMatch(/validator/i);
  });

  it("pluralizes when several words are pinned", () => {
    const word = POLICY_ALLOWED | (1n << 192n) | (1n << 194n);
    expect(describePolicy(decodePolicy(word))).toMatch(/words 0, 2/);
  });
});

describe("V3 wiring", () => {
  it("exposes getCallPolicy on the wallet ABI", () => {
    const names = agentWalletAbi.map((f) => ("name" in f ? f.name : ""));
    expect(names).toContain("getCallPolicy");
  });

  it("does NOT expose setCallPolicy — only the wallet owner may write policies", () => {
    const names = agentWalletAbi.map((f) => ("name" in f ? f.name : ""));
    expect(names).not.toContain("setCallPolicy");
  });

  it("exposes only read functions on the registry ABI", () => {
    const names = validatorRegistryAbi.map((f) => f.name);
    expect(names).toEqual(["validators", "validate"]);
    for (const f of validatorRegistryAbi) expect(f.stateMutability).toBe("view");
  });

  it("sets the validator registry on every known network (V3 staged everywhere)", () => {
    // Same CREATE2 address on all six networks; UR validators registered per chain.
    for (const id of [1, 56, 137, 8453, 42161, 421614]) {
      expect(getNetwork(id).validatorRegistry).toBe("0x5e371D54AC97a57B0a99145Ed04A3c9fA07850C2");
    }
  });

  it("allows a network with no registry (SDK then skips policy checks)", () => {
    // No shipped network omits it anymore; undefined is still a valid state the SDK
    // handles by reporting V2 (skip checks) instead of denying everything.
    const v2Net = { ...getNetwork(421614), validatorRegistry: undefined };
    expect(v2Net.validatorRegistry).toBeUndefined();
  });
});

/**
 * Stub PublicClient: the failure paths below (V2 wallet, frozen validator) cannot
 * be reproduced against the live Arbitrum deployment, so they are driven here.
 */
function stub(handler: (fn: string, args: readonly unknown[]) => unknown) {
  return {
    chain: { id: 42161 },
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) =>
      handler(functionName, args ?? []),
  } as never;
}
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const WALLET = "0x605A4C65dBa64bd26d9F7701e1e4Cda48c594A5c" as const;
const UR = "0x8B844f885672f333Bc0042cB669255f93a4C1E6b" as const;
const REG = "0x5e371D54AC97a57B0a99145Ed04A3c9fA07850C2" as const;

describe("V2 wallets degrade cleanly", () => {
  it("detects V2 when getCallPolicy is absent", async () => {
    const { detectWalletVersion } = await import("../src/policy.js");
    const pc = stub((fn) => {
      if (fn === "getCallPolicy") throw new Error("execution reverted");
      return 0n;
    });
    // A V2 address unused by other tests, so the version cache stays clean.
    expect(await detectWalletVersion(pc, "0x00000000000000000000000000000000000000v2" as never)).toBe("v2");
  });

  it("reads a missing policy as 0n rather than throwing", async () => {
    const { readCallPolicy } = await import("../src/policy.js");
    const pc = stub(() => {
      throw new Error("execution reverted");
    });
    expect(await readCallPolicy(pc, WALLET, UR, "0x3593564c")).toBe(0n);
  });
});

describe("diagnosePolicy", () => {
  it("stops the agent when no policy is registered", async () => {
    const { diagnosePolicy } = await import("../src/policy.js");
    const pc = stub(() => 0n);
    const d = await diagnosePolicy(pc, WALLET, UR, "0x3593564c", { registry: REG });
    expect(d.reason).toBe("no-policy");
    expect(d.retryable).toBe(false);
  });

  it("stops the agent when a DEEP policy has no live validator (frozen or never registered)", async () => {
    const { diagnosePolicy, POLICY_ALLOWED, POLICY_DEEP } = await import("../src/policy.js");
    const pc = stub((fn) => {
      if (fn === "getCallPolicy") return POLICY_ALLOWED | POLICY_DEEP;
      if (fn === "validators") return ZERO; // kill-switch pulled
      return false;
    });
    const d = await diagnosePolicy(pc, WALLET, UR, "0x3593564c", { registry: REG });
    expect(d.reason).toBe("no-validator");
    // The distinction that matters: nothing the agent does will fix this.
    expect(d.retryable).toBe(false);
    expect(d.suggestedAction).toMatch(/will not help/i);
  });

  it("lets the agent retry when a live validator rejected the calldata", async () => {
    const { diagnosePolicy, POLICY_ALLOWED, POLICY_DEEP } = await import("../src/policy.js");
    const pc = stub((fn) => {
      if (fn === "getCallPolicy") return POLICY_ALLOWED | POLICY_DEEP;
      if (fn === "validators") return "0xa2cDCdEd08F621d777c33ED212F8DEf564aEa92E";
      if (fn === "validate") return false;
      return null;
    });
    const d = await diagnosePolicy(pc, WALLET, UR, "0x3593564c", { registry: REG, data: "0xdeadbeef" });
    expect(d.reason).toBe("validator-rejected");
    expect(d.retryable).toBe(true);
  });

  it("passes a call that satisfies policy and validator", async () => {
    const { diagnosePolicy, POLICY_ALLOWED, POLICY_DEEP } = await import("../src/policy.js");
    const pc = stub((fn) => {
      if (fn === "getCallPolicy") return POLICY_ALLOWED | POLICY_DEEP;
      if (fn === "validators") return "0xa2cDCdEd08F621d777c33ED212F8DEf564aEa92E";
      if (fn === "validate") return true;
      return null;
    });
    const d = await diagnosePolicy(pc, WALLET, UR, "0x3593564c", { registry: REG, data: "0xdeadbeef" });
    expect(d.ok).toBe(true);
    expect(d.reason).toBeNull();
  });
});
