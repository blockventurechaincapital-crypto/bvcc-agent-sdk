import { describe, expect, it } from "vitest";
import { ok, fail, type ActionContext } from "../src/results.js";

const ctx: ActionContext = {
  network: "Arbitrum One",
  chainId: 42161,
  walletAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  agentAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
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
