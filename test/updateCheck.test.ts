import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BvccAgentClient } from "../src/client.js";
import {
  checkForUpdate,
  isNewerVersion,
  resetUpdateCheck,
  type FetchLike,
  type UpdateCheckTarget,
} from "../src/updateCheck.js";

const TARGET: UpdateCheckTarget = {
  package: "@bvcc/agent-mcp",
  current: "0.3.0",
  command: "npx -y @bvcc/agent-mcp@latest",
  releasesUrl: "https://github.com/x/y/releases/tag/v",
};

function registry(version: string): FetchLike & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: true, json: async () => ({ version }) })) as never;
}

beforeEach(() => {
  resetUpdateCheck();
  delete process.env.BVCC_NO_UPDATE_CHECK;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.BVCC_NO_UPDATE_CHECK;
});

describe("isNewerVersion", () => {
  it("compares major.minor.patch numerically", () => {
    expect(isNewerVersion("0.3.1", "0.3.0")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.3.0", "0.3.0")).toBe(false);
    expect(isNewerVersion("0.2.9", "0.3.0")).toBe(false);
    expect(isNewerVersion("garbage", "0.3.0")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  it("reports a newer version with the command and the release link", async () => {
    const fetch = registry("0.3.1");
    const r = await checkForUpdate(TARGET, { fetch });
    expect(r).toEqual({
      current: "0.3.0",
      latest: "0.3.1",
      command: "npx -y @bvcc/agent-mcp@latest",
      changelogUrl: "https://github.com/x/y/releases/tag/v0.3.1",
    });
    // A plain GET to the package's /latest: no user, wallet or agent data.
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://registry.npmjs.org/@bvcc/agent-mcp/latest");
    expect(Object.keys(init.headers)).toEqual(["accept"]);
  });

  it("returns null on the same or an older version", async () => {
    expect(await checkForUpdate(TARGET, { fetch: registry("0.3.0") })).toBeNull();
    resetUpdateCheck();
    expect(await checkForUpdate(TARGET, { fetch: registry("0.2.2") })).toBeNull();
  });

  it("returns null when the registry is down or answers an error", async () => {
    const down: FetchLike = async () => { throw new Error("ECONNREFUSED"); };
    expect(await checkForUpdate(TARGET, { fetch: down })).toBeNull();
    resetUpdateCheck();
    const http500: FetchLike = async () => ({ ok: false, json: async () => ({}) });
    expect(await checkForUpdate(TARGET, { fetch: http500 })).toBeNull();
    resetUpdateCheck();
    const badBody: FetchLike = async () => ({ ok: true, json: async () => { throw new Error("bad json"); } });
    expect(await checkForUpdate(TARGET, { fetch: badBody })).toBeNull();
  });

  it("gives up after the timeout when the registry does not answer", async () => {
    const hang: FetchLike = () => new Promise(() => {});
    const t0 = Date.now();
    expect(await checkForUpdate(TARGET, { fetch: hang, timeoutMs: 50 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("does nothing when BVCC_NO_UPDATE_CHECK is set", async () => {
    process.env.BVCC_NO_UPDATE_CHECK = "1";
    const fetch = registry("9.9.9");
    expect(await checkForUpdate(TARGET, { fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does nothing on a dev build", async () => {
    const fetch = registry("9.9.9");
    expect(await checkForUpdate({ ...TARGET, current: "0.0.0-dev" }, { fetch })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks the registry once per process", async () => {
    const fetch = registry("0.3.1");
    await checkForUpdate(TARGET, { fetch });
    await checkForUpdate(TARGET, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("getAgentStatus.updateAvailable", () => {
  const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
  const WALLET = "0x56ac9854536155d6eE8719203F52AeCF70de7f41" as const;

  function client(updateCheck?: UpdateCheckTarget | false) {
    const c = new BvccAgentClient({ network: 42161, account: KEY, walletAddress: WALLET, updateCheck });
    // No chain access: the permission reads are stubbed.
    vi.spyOn(c, "getPermission").mockResolvedValue({
      active: true, expiry: 0n, allowedTokens: [], allowedProtocols: [], allowedRecipients: [],
    } as never);
    vi.spyOn(c, "isPaused").mockResolvedValue(false);
    vi.spyOn(c, "walletVersion").mockResolvedValue("v5");
    return c;
  }

  it("is present when a newer version is out", async () => {
    vi.stubGlobal("fetch", registry("0.3.1"));
    const s = await client(TARGET).getAgentStatus();
    expect(s.updateAvailable?.latest).toBe("0.3.1");
    expect(s.isAuthorized).toBe(true);
  });

  it("is absent on the latest version", async () => {
    vi.stubGlobal("fetch", registry("0.3.0"));
    const s = await client(TARGET).getAgentStatus();
    expect("updateAvailable" in s).toBe(false);
  });

  it("is absent, and the status still arrives, when the registry is down", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const s = await client(TARGET).getAgentStatus();
    expect("updateAvailable" in s).toBe(false);
    expect(s.isAuthorized).toBe(true);
  });

  it("never calls the registry with updateCheck: false or before getAgentStatus", async () => {
    const fetch = registry("9.9.9");
    vi.stubGlobal("fetch", fetch);
    const off = client(false);
    client(TARGET); // constructing alone asks nothing
    expect(fetch).not.toHaveBeenCalled();
    const s = await off.getAgentStatus();
    expect("updateAvailable" in s).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
