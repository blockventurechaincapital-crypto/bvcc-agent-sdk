/**
 * Source tag — which tool built a transaction.
 *
 * Eight bytes appended to the end of the `executeAsAgent` calldata:
 *
 *   "bvcc" (4 bytes, magic) ++ tool (1 byte: 0x01 SDK, 0x02 MCP) ++ version (3 bytes:
 *   major, minor, patch)
 *
 * The ABI decoder ignores bytes past the encoded arguments, so the wallet behaves
 * exactly the same with or without the tag (checked on V4 and V5 wallets; it costs
 * about 100 gas). It names only the tool and its version — never the user, the
 * wallet or the agent. Turn it off with `sourceTag: false` in the client options.
 *
 * Its purpose is to tell, on-chain, which wallets operate through the SDK or the MCP
 * and which version they run, so failures can be tied to a release.
 */
import { concat, toHex, type Hex } from "viem";

import { SDK_VERSION } from "./version.js";

export type SourceTool = "sdk" | "mcp";

export interface SourceTagOptions {
  tool: SourceTool;
  /** Semantic version "major.minor.patch"; anything after the patch is ignored. */
  version: string;
}

/** "bvcc" in ASCII. */
export const SOURCE_TAG_MAGIC: Hex = "0x62766363";
const TOOL_BYTE: Record<SourceTool, number> = { sdk: 0x01, mcp: 0x02 };

/** The 8-byte tag for a tool and version. */
export function encodeSourceTag(opts: SourceTagOptions): Hex {
  const parts = opts.version.split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10));
  const [major, minor, patch] = [0, 1, 2].map((i) => {
    const n = parts[i];
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 255) : 0;
  });
  return concat([SOURCE_TAG_MAGIC, toHex(TOOL_BYTE[opts.tool], { size: 1 }), toHex(major, { size: 1 }), toHex(minor, { size: 1 }), toHex(patch, { size: 1 })]);
}

/** The SDK's own tag, used when the caller does not say otherwise. */
export const DEFAULT_SOURCE: SourceTagOptions = { tool: "sdk", version: SDK_VERSION };

/**
 * Read the tag back from a transaction's input, or null when it has none. For
 * analytics: point it at the `input` of any transaction sent to an agent wallet.
 */
export function decodeSourceTag(input: Hex): { tool: SourceTool | "unknown"; version: string } | null {
  if (!input || input.length < 2 + 16) return null;
  const tail = input.slice(-16).toLowerCase();
  if (tail.slice(0, 8) !== SOURCE_TAG_MAGIC.slice(2)) return null;
  const byte = (i: number) => Number.parseInt(tail.slice(8 + i * 2, 10 + i * 2), 16);
  const tool = byte(0) === 1 ? "sdk" : byte(0) === 2 ? "mcp" : "unknown";
  return { tool, version: `${byte(1)}.${byte(2)}.${byte(3)}` };
}
