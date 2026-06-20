import { describe, expect, it } from "vitest";
import { ok, fail, type ActionContext } from "../src/results.js";

const ctx: ActionContext = {
  network: "Arbitrum One",
  chainId: 42161,
  walletAddress: "0x727D0806DFaB184eC9006af1B54d3fC3EfD801ab",
  agentAddress: "0x38529C66F3cf22453D66B9E2A20FdF2676544aB4",
};

describe("structured results", () => {
  it("formats a success result", () => {
    const r = ok("sendNative", "0xabc", ctx);
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ action: "sendNative", txHash: "0xabc", chainId: 42161 });
  });

  it("formats a failure result from a decoded revert", () => {
    const r = fail(
      "swapV4",
      {
        errorName: "TokenNotAllowed",
        humanMessage: "not allowed",
        suggestedAction: "whitelist it",
        rawError: "0xa29c4986",
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorName).toBe("TokenNotAllowed");
      expect(r.suggestedAction).toBe("whitelist it");
      expect(r.rawError).toBe("0xa29c4986");
      expect(r.walletAddress).toBe(ctx.walletAddress);
    }
  });
});
