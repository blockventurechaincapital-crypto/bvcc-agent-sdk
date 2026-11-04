/**
 * Update check — tells an agent that a newer version of the SDK (or the MCP) is out.
 *
 * One plain GET to the public npm registry (`/<package>/latest`). It sends nothing
 * about the user, the wallet or the agent; like any `npm install`, the registry sees
 * the caller's IP address. It never throws and never waits more than `timeoutMs`:
 * when the registry is down or slow, the answer is simply "no update known".
 *
 * The client runs it the first time `getAgentStatus` is called, never at construction,
 * and once per process: later calls reuse the answer. Turn it off with
 * `updateCheck: false` in the client options or `BVCC_NO_UPDATE_CHECK=1`.
 */

import { SDK_VERSION } from "./version.js";

/** What to check: the package, the running version and how to upgrade. */
export interface UpdateCheckTarget {
  /** npm package name, e.g. "@bvcc/agent-sdk". */
  package: string;
  /** The version running now ("major.minor.patch"). */
  current: string;
  /** Command that installs the latest version. */
  command: string;
  /** Base URL of the GitHub releases; "v<latest>" is appended. */
  releasesUrl: string;
}

/** Returned by `getAgentStatus` when a newer version is published. */
export interface UpdateAvailable {
  current: string;
  latest: string;
  command: string;
  changelogUrl: string;
}

/** The part of `fetch` this module uses (the SDK does not assume DOM types). */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: unknown },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface CheckForUpdateOptions {
  /** Give up after this long (default 2000 ms). */
  timeoutMs?: number;
  /** Replace the global `fetch` (tests). */
  fetch?: FetchLike;
}

const REGISTRY = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 2_000;

/** The SDK's own target, used when the client options do not name another one. */
export const SDK_UPDATE_TARGET: UpdateCheckTarget = {
  package: "@bvcc/agent-sdk",
  current: SDK_VERSION,
  command: "npm i @bvcc/agent-sdk@latest",
  releasesUrl: "https://github.com/blockventurechaincapital-crypto/bvcc-agent-sdk/releases/tag/v",
};

/** True when `BVCC_NO_UPDATE_CHECK` is set to 1/true/yes. Safe outside Node. */
export function updateCheckDisabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = env?.BVCC_NO_UPDATE_CHECK?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `a` is a higher "major.minor.patch" than `b`. */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

const memo = new Map<string, Promise<UpdateAvailable | null>>();

/**
 * The newer version of `target.package`, or null when there is none, the check is
 * off, the running version is a dev build, or the registry did not answer in time.
 * Asked once per package and version per process.
 */
export function checkForUpdate(
  target: UpdateCheckTarget,
  opts: CheckForUpdateOptions = {},
): Promise<UpdateAvailable | null> {
  // A dev or pre-release build ("0.0.0-dev", "0.4.0-beta.1") has nothing to compare.
  const releaseBuild = /^\d+\.\d+\.\d+$/.test(target.current) && target.current !== "0.0.0";
  if (updateCheckDisabled() || !releaseBuild) return Promise.resolve(null);
  const key = `${target.package}@${target.current}`;
  const hit = memo.get(key);
  if (hit) return hit;
  const p = ask(target, opts);
  memo.set(key, p);
  return p;
}

async function ask(target: UpdateCheckTarget, opts: CheckForUpdateOptions): Promise<UpdateAvailable | null> {
  const doFetch = opts.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof doFetch !== "function") return null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The timer wins even if the fetch ignores the abort signal.
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve(null);
    }, timeoutMs);
    // Do not keep a Node process alive just for this.
    (timer as { unref?: () => void }).unref?.();
  });
  const request = (async () => {
    try {
      const res = await doFetch(`${REGISTRY}/${target.package}/latest`, {
        headers: { accept: "application/json" },
        signal: controller?.signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: unknown };
      const latest = typeof body.version === "string" ? body.version : "";
      if (!isNewerVersion(latest, target.current)) return null;
      return {
        current: target.current,
        latest,
        command: target.command,
        changelogUrl: `${target.releasesUrl}${latest}`,
      };
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Forget earlier answers (tests). */
export function resetUpdateCheck(): void {
  memo.clear();
}
