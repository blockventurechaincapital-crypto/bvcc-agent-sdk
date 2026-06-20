import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { decodeRevert, agentErrorAbi, __errorSelectors } from "../src/errors.js";

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
});
