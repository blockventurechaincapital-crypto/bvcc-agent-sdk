import { describe, expect, it } from "vitest";
import { encodeErrorResult, toFunctionSelector } from "viem";
import { decodeRevert, agentErrorAbi, __errorSelectors } from "../src/errors.js";

const errStringAbi = [{ type: "error", name: "Error", inputs: [{ type: "string" }] }] as const;

describe("error selectors", () => {
  it("computes selectors at load for known errors", () => {
    const sel = toFunctionSelector("NotAuthorizedAgent()").toLowerCase();
    expect(__errorSelectors.get(sel)?.name).toBe("NotAuthorizedAgent");
  });

  it("exposes an error ABI for viem decoding", () => {
    const names = agentErrorAbi.map((e) => e.name);
    expect(names).toContain("DailyLimitExceeded");
    expect(names).toContain("EnforcedPause");
  });
});

describe("decodeRevert", () => {
  it("maps a raw revert-data selector to a named error", () => {
    const data = toFunctionSelector("DailyLimitExceeded()");
    const d = decodeRevert({ data });
    expect(d.errorName).toBe("DailyLimitExceeded");
    expect(d.humanMessage).toMatch(/daily/i);
    expect(d.suggestedAction.length).toBeGreaterThan(0);
    expect(d.rawError).toBe(data.toLowerCase());
  });

  it("maps a viem-style nested errorName", () => {
    const err = { cause: { cause: { data: { errorName: "ProtocolNotAllowed" } } } };
    const d = decodeRevert(err);
    expect(d.errorName).toBe("ProtocolNotAllowed");
    expect(d.humanMessage).toMatch(/whitelist/i);
  });

  it("finds a selector embedded in a message string", () => {
    const sel = toFunctionSelector("RecipientNotAllowed()");
    const d = decodeRevert(new Error(`execution reverted, data: "${sel}"`));
    expect(d.errorName).toBe("RecipientNotAllowed");
  });

  it("degrades gracefully for unknown reverts", () => {
    const d = decodeRevert({ data: "0xdeadbeef" });
    expect(d.errorName).toBeNull();
    expect(d.humanMessage).toMatch(/unrecognized/i);
    expect(d.rawError).toBe("0xdeadbeef");
  });

  it("never throws on weird input", () => {
    expect(() => decodeRevert(undefined)).not.toThrow();
    expect(() => decodeRevert("just a string")).not.toThrow();
  });

  it("decodes a standard Error(string) revert to its reason", () => {
    const data = encodeErrorResult({ abi: errStringAbi, errorName: "Error", args: ["Price slippage check"] });
    const d = decodeRevert({ data });
    expect(d.errorName).toBeNull();
    expect(d.humanMessage).toMatch(/Price slippage check/);
    expect(d.suggestedAction).toMatch(/ratio|slippage/i);
    expect(d.rawError).toBe("Price slippage check");
  });

  it("does NOT surface an address embedded in the message as the error", () => {
    // Regression: a viem message mentioning the sender (0x70997970…) must not be
    // mistaken for a revert selector.
    const d = decodeRevert(new Error("execution reverted; from 0x70997970C51812dc3A010C7d01b50e0d17dc79C8"));
    expect(d.rawError).not.toBe("0x70997970");
    expect(d.errorName).toBeNull();
  });
});

describe("wallet V3 policy errors", () => {
  const cases = [
    ["SelectorNotAllowed", /not registered a call policy/i],
    ["PinnedArgMismatch", /pinned calldata argument/i],
    ["PolicyValidationFailed", /deep validation/i],
    ["CalldataTooShort", /too short/i],
  ] as const;

  for (const [name, msgRe] of cases) {
    it(`decodes ${name}`, () => {
      const d = decodeRevert({ data: toFunctionSelector(`${name}()`) });
      expect(d.errorName).toBe(name);
      expect(d.humanMessage).toMatch(msgRe);
      expect(d.suggestedAction.length).toBeGreaterThan(0);
    });
  }

  it("matches the selectors the contract actually reverts with", () => {
    // Observed on Arbitrum mainnet via cast, 20 Jul 2026.
    expect(toFunctionSelector("PinnedArgMismatch()")).toBe("0xaa53a959");
    expect(toFunctionSelector("PolicyValidationFailed()")).toBe("0x7e45c527");
    expect(toFunctionSelector("SelectorNotAllowed()")).toBe("0xbdb518d2");
    expect(toFunctionSelector("CalldataTooShort()")).toBe("0x21bbd70f");
  });

  it("tells the agent not to retry a missing policy", () => {
    const d = decodeRevert({ data: toFunctionSelector("SelectorNotAllowed()") });
    expect(d.suggestedAction).toMatch(/will not help/i);
  });

  it("points a pinned-arg failure back at the wallet address", () => {
    const d = decodeRevert({ data: toFunctionSelector("PinnedArgMismatch()") });
    expect(d.suggestedAction).toMatch(/wallet address/i);
  });
});
