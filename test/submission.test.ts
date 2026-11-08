import { afterEach, describe, expect, it, vi } from "vitest";
import { keccak256, type Hex } from "viem";

import { BvccAgentClient } from "../src/client.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const WALLET = "0x56ac9854536155d6eE8719203F52AeCF70de7f41" as const;
const TO = "0xA3e06B6443D911915bb4eD157832d43C25D6617D" as const;

type Net = {
  /** What sendRawTransaction does with each attempt, in order. */
  send: Array<"ok" | "timeout" | "nonceLow">;
  /** Whether getTransaction finds the hash after a failed send. */
  found?: boolean;
  /** What the receipt wait does. */
  receipt?: "success" | "reverted" | "timeout";
};

/** A client on a simulated network. Signing is real; every chain call is stubbed. */
function client(net: Net) {
  const c = new BvccAgentClient({ network: 42161, account: KEY, walletAddress: WALLET, updateCheck: false, sourceTag: false });
  (c as unknown as { lookupPolicy: object }).lookupPolicy = { tries: 2, pauseMs: 1 };
  vi.spyOn(c, "walletVersion").mockResolvedValue("v4");
  const pc = c.publicClient;
  let confirmed = 7; // confirmed nonce count
  const nonces: number[] = [];
  const rawSent: Hex[] = [];
  vi.spyOn(pc, "estimateGas").mockResolvedValue(21_000n);
  vi.spyOn(pc, "getTransactionCount").mockImplementation((async () => confirmed) as never);
  vi.spyOn(c.walletClient, "prepareTransactionRequest").mockImplementation((async (r: { nonce: number; to: Hex; data: Hex; gas: bigint }) => {
    nonces.push(r.nonce);
    return { to: r.to, data: r.data, gas: r.gas, nonce: r.nonce, chainId: 42161, type: "eip1559", maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 0n, value: 0n };
  }) as never);
  let attempt = 0;
  vi.spyOn(pc, "sendRawTransaction").mockImplementation((async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
    rawSent.push(serializedTransaction);
    const what = net.send[attempt++] ?? "ok";
    if (what === "timeout") throw new Error("The request took too long to respond.");
    if (what === "nonceLow") throw new Error("Nonce provided for the transaction is lower than the current nonce of the account.");
    return keccak256(serializedTransaction);
  }) as never);
  vi.spyOn(pc, "getTransaction").mockImplementation((async () => {
    if (net.found) return { hash: "0x" } as never;
    throw new Error("Transaction not found");
  }) as never);
  vi.spyOn(pc, "waitForTransactionReceipt").mockImplementation((async () => {
    if (net.receipt === "timeout") throw new Error("Timed out while waiting for transaction");
    confirmed += 1;
    return { status: net.receipt === "reverted" ? "reverted" : "success", blockNumber: 100n, gasUsed: 50_000n } as never;
  }) as never);
  vi.spyOn(pc, "call").mockRejectedValue(new Error("execution reverted"));
  return { c, nonces, rawSent };
}

afterEach(() => vi.restoreAllMocks());

describe("sending an operation never does it twice", () => {
  it("confirmed: ok with the hash of the signed transaction", async () => {
    const { c, rawSent } = client({ send: ["ok"], receipt: "success" });
    const r = await c.sendNative(TO, 1n);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.txHash).toBe(keccak256(rawSent[0]));
  });

  it("send times out but the node has it: reported as sent, never re-sent", async () => {
    const { c, rawSent } = client({ send: ["timeout"], found: true, receipt: "success" });
    const r = await c.sendNative(TO, 1n);
    expect(r.ok).toBe(true);
    expect(rawSent).toHaveLength(1);
  });

  it("send times out and the transaction cannot be found: SubmissionUnknown, with the hash, not retryable", async () => {
    const { c, rawSent } = client({ send: ["timeout"], found: false });
    const r = await c.sendNative(TO, 1n);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorName).toBe("SubmissionUnknown");
      expect(r.retryable).toBe(false);
      expect(r.txHash).toBe(keccak256(rawSent[0]));
    }
    expect(rawSent).toHaveLength(1);
  });

  it("sent but not confirmed in time: NotYetConfirmed, with the hash, not retryable", async () => {
    const { c, rawSent } = client({ send: ["ok"], receipt: "timeout" });
    const r = await c.sendNative(TO, 1n);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorName).toBe("NotYetConfirmed");
      expect(r.retryable).toBe(false);
      expect(r.txHash).toBe(keccak256(rawSent[0]));
    }
  });

  it("the agent repeats it while the first is still pending: it is not sent", async () => {
    const { c, rawSent } = client({ send: ["ok"], receipt: "timeout" });
    await c.sendNative(TO, 1n); // pending
    const again = await c.sendNative(TO, 1n);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.errorName).toBe("PreviousStillPending");
    }
    expect(rawSent).toHaveLength(1);
  });

  it("nonce already taken by another transaction: NonceTaken, not retryable, nothing re-sent", async () => {
    const { c, rawSent } = client({ send: ["nonceLow"], found: false });
    const r = await c.sendNative(TO, 1n);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorName).toBe("NonceTaken");
      expect(r.retryable).toBe(false);
    }
    expect(rawSent).toHaveLength(1);
  });

  it("reverted on-chain: a failure with the hash", async () => {
    const { c } = client({ send: ["ok"], receipt: "reverted" });
    const r = await c.sendNative(TO, 1n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.txHash).toBeTruthy();
  });

  it("two operations at once go out one after the other, with consecutive nonces", async () => {
    const { c, nonces, rawSent } = client({ send: ["ok", "ok"], receipt: "success" });
    const [a, b] = await Promise.all([c.sendNative(TO, 1n), c.sendNative(TO, 2n)]);
    expect(a.ok && b.ok).toBe(true);
    expect(nonces).toEqual([7, 8]);
    expect(rawSent).toHaveLength(2);
  });
});
