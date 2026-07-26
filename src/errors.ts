import { decodeErrorResult, toFunctionSelector, type Hex } from "viem";

/**
 * Human-readable decoding of contract reverts.
 *
 * Selectors are computed at load time from the error signatures (via viem) — no
 * hardcoded 4-byte values to drift. Covers the BVCC Agent Wallet custom errors
 * plus OpenZeppelin's `EnforcedPause`.
 *
 * This is a convenience layer: it explains *likely* causes from the revert. The
 * BVCC Agent Wallet contract remains the source of truth for what is allowed.
 */

export interface DecodedRevert {
  /** Matched custom-error name, or null if unrecognized. */
  errorName: string | null;
  humanMessage: string;
  suggestedAction: string;
  /** Selector or a short, non-sensitive summary. Never contains secrets. */
  rawError: string;
}

interface Entry {
  name: string;
  signature: string;
  humanMessage: string;
  suggestedAction: string;
}

const ENTRIES: Entry[] = [
  {
    name: "NotAuthorizedAgent",
    signature: "NotAuthorizedAgent()",
    humanMessage: "This agent is not authorized on the wallet (revoked or never authorized).",
    suggestedAction: "Authorize this agent EOA from the dashboard, or check WALLET_ADDRESS / the agent key.",
  },
  {
    name: "AgentPermissionsExpired",
    signature: "AgentPermissionsExpired()",
    humanMessage: "The agent's permissions have expired.",
    suggestedAction: "Re-authorize the agent with a new expiry (or 0 for no expiry).",
  },
  {
    name: "EnforcedPause",
    signature: "EnforcedPause()",
    humanMessage: "All agents are currently paused on this wallet.",
    suggestedAction: "Unpause agents from the dashboard before retrying.",
  },
  {
    name: "AgentCannotCallWallet",
    signature: "AgentCannotCallWallet()",
    humanMessage: "An execution targets the wallet itself, which agents cannot call.",
    suggestedAction: "Remove any call whose target is the wallet address from the batch.",
  },
  {
    name: "ExceedsPerTxLimit",
    signature: "ExceedsPerTxLimit()",
    humanMessage: "A single execution exceeds the agent's per-transaction ETH limit.",
    suggestedAction: "Lower the value of that item, or raise maxPerTx when authorizing.",
  },
  {
    name: "DailyLimitExceeded",
    signature: "DailyLimitExceeded()",
    humanMessage: "This would exceed the agent's daily ETH limit (UTC day).",
    suggestedAction: "Reduce the amount, wait for the daily reset, or raise the daily limit.",
  },
  {
    name: "PeriodBudgetExceeded",
    signature: "PeriodBudgetExceeded()",
    humanMessage: "This would exceed the agent's rolling-period ETH budget.",
    suggestedAction: "Reduce the amount, wait for the period to roll over, or raise the period budget.",
  },
  {
    name: "AgentBudgetExceeded",
    signature: "AgentBudgetExceeded()",
    humanMessage: "This would exceed the agent's lifetime ETH budget.",
    suggestedAction: "Reduce the amount, or increase the agent's total budget.",
  },
  {
    name: "NoTokensWhitelisted",
    signature: "NoTokensWhitelisted()",
    humanMessage: "The agent has no ERC-20 tokens whitelisted, so token transfers are denied.",
    suggestedAction: "Add the token to allowedTokens when authorizing the agent.",
  },
  {
    name: "TokenNotAllowed",
    signature: "TokenNotAllowed()",
    humanMessage: "This token is not in the agent's allowedTokens whitelist.",
    suggestedAction: "Add the token to allowedTokens, or use an allowed token.",
  },
  {
    name: "ExceedsTokenMaxAmount",
    signature: "ExceedsTokenMaxAmount()",
    humanMessage: "The amount exceeds this token's per-transaction limit.",
    suggestedAction: "Lower the amount, or raise the token's per-tx limit when authorizing.",
  },
  {
    name: "TokenBatchLimitExceeded",
    signature: "TokenBatchLimitExceeded()",
    humanMessage: "The cumulative amount of a token across the batch exceeds its limit.",
    suggestedAction: "Split the batch or lower amounts so the per-token total stays within limits.",
  },
  {
    name: "TokenDailyLimitExceeded",
    signature: "TokenDailyLimitExceeded()",
    humanMessage: "This would exceed the token's daily limit (UTC day).",
    suggestedAction: "Reduce the amount, wait for the daily reset, or raise the token daily limit.",
  },
  {
    name: "TokenTotalBudgetExceeded",
    signature: "TokenTotalBudgetExceeded()",
    humanMessage: "This would exceed the token's lifetime budget.",
    suggestedAction: "Reduce the amount, or increase the token's total budget.",
  },
  {
    name: "NoProtocolsWhitelisted",
    signature: "NoProtocolsWhitelisted()",
    humanMessage: "The agent has no DeFi protocols whitelisted, so protocol calls are denied.",
    suggestedAction: "Add the router/protocol to allowedProtocols when authorizing.",
  },
  {
    name: "ProtocolNotAllowed",
    signature: "ProtocolNotAllowed()",
    humanMessage: "A call targets a protocol that is not in the agent's allowedProtocols whitelist.",
    suggestedAction: "Add that contract (e.g. the router and Permit2) to allowedProtocols.",
  },
  {
    name: "RecipientNotAllowed",
    signature: "RecipientNotAllowed()",
    humanMessage: "The recipient is not in the agent's allowedRecipients whitelist.",
    suggestedAction: "Add the recipient to allowedRecipients, or send to an allowed address.",
  },
  // ── Wallet V3: call policies ──────────────────────────────────────────────
  // Whitelisting a protocol is no longer enough — each (target, selector) needs a
  // policy, and a policy can pin calldata words to the wallet. These reverts mean
  // the policy layer stopped the call, not the permission layer.
  {
    name: "SelectorNotAllowed",
    signature: "SelectorNotAllowed()",
    humanMessage:
      "The protocol is whitelisted, but the wallet owner has not registered a call policy for this specific function.",
    suggestedAction:
      "Ask the owner to add this protocol to the agent in the dashboard, which registers the required policies. Retrying the same call will not help.",
  },
  {
    name: "PinnedArgMismatch",
    signature: "PinnedArgMismatch()",
    humanMessage:
      "A pinned calldata argument is wrong: the policy requires that position to be the wallet itself (or a whitelisted protocol).",
    suggestedAction:
      "Set the recipient/onBehalfOf argument to the wallet address. Funds from an agent call must always land back in the wallet.",
  },
  {
    name: "PolicyValidationFailed",
    signature: "PolicyValidationFailed()",
    // Two very different causes; `explainPolicyFailure` tells them apart on-chain.
    humanMessage:
      "Deep validation rejected this call: either no validator is active for this protocol, or the validator refused this calldata.",
    suggestedAction:
      "Check whether a validator is registered for the target protocol. If there is one, the calldata used an unsupported command or a recipient other than the wallet.",
  },
  {
    name: "CalldataTooShort",
    signature: "CalldataTooShort()",
    humanMessage: "The call data is too short to contain a function selector.",
    suggestedAction: "Build the call with a proper 4-byte selector and ABI-encoded arguments.",
  },
];

const bySelector = new Map<string, Entry>();
const byName = new Map<string, Entry>();
for (const e of ENTRIES) {
  byName.set(e.name, e);
  try {
    bySelector.set(toFunctionSelector(e.signature).toLowerCase(), e);
  } catch {
    /* signature should always be valid; ignore if viem can't parse */
  }
}

/** Error-fragment ABI so viem can name these reverts during `simulateContract`. */
export const agentErrorAbi = ENTRIES.map((e) => ({
  type: "error" as const,
  name: e.name,
  inputs: [] as const,
}));

// Standard Solidity reverts, so a `require(false, "msg")` / assert is decoded to
// its actual message instead of surfacing a bare selector (or, worse, an address
// picked out of the error text).
const SELECTOR_STRING_ERROR = "0x08c379a0"; // Error(string)
const SELECTOR_PANIC = "0x4e487b71"; // Panic(uint256)
const STANDARD_ERROR_ABI = [
  { type: "error", name: "Error", inputs: [{ type: "string" }] },
  { type: "error", name: "Panic", inputs: [{ type: "uint256" }] },
] as const;

// A full revert-data blob (selector + ABI args), not just a 4-byte selector.
const DATA_RE = /^0x[0-9a-fA-F]{8,}$/;
// A hex selector appearing *inside* free-form text (e.g. viem's message). Only
// trusted when it maps to a KNOWN error — otherwise it may be an address/hash in
// the message (a real bug once surfaced the agent address as the "selector").
const EMBEDDED_HEX_RE = /0x[0-9a-fA-F]{8,}/g;

interface Scan {
  /** Authoritative revert data from a structured field (o.data / o.signature). */
  dataHex?: string;
  /** errorName carried by a viem error object. */
  errorName?: string;
  /** Hex candidates found inside message text (only used if they name a known error). */
  embedded: string[];
  /** First human-readable message seen. */
  raw: string;
}

function scan(error: unknown): Scan {
  let raw = "";
  let dataHex: string | undefined;
  let errorName: string | undefined;
  const embedded: string[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];

  while (stack.length) {
    const node = stack.pop();
    if (node == null || seen.has(node)) continue;
    seen.add(node);

    if (typeof node === "string") {
      const s = node.trim();
      if (DATA_RE.test(s)) {
        // A bare hex blob is revert data.
        if (!dataHex) dataHex = s.toLowerCase();
      } else {
        if (!raw) raw = node;
        // Collect embedded selectors, but do not trust them yet.
        for (const m of node.match(EMBEDDED_HEX_RE) ?? []) embedded.push(m.slice(0, 10).toLowerCase());
      }
      continue;
    }
    if (typeof node !== "object") continue;

    const o = node as Record<string, unknown>;
    if (typeof o.errorName === "string" && !errorName) errorName = o.errorName;
    if (typeof o.data === "string" && DATA_RE.test(o.data) && !dataHex) dataHex = o.data.toLowerCase();
    if (o.data && typeof o.data === "object") {
      const dn = (o.data as Record<string, unknown>).errorName;
      if (typeof dn === "string" && !errorName) errorName = dn;
    }
    if (typeof o.signature === "string" && DATA_RE.test(o.signature) && !dataHex) {
      dataHex = o.signature.toLowerCase();
    }
    if (typeof o.shortMessage === "string" && !raw) raw = o.shortMessage;

    stack.push(o.cause, o.error, o.message, o.details, o.shortMessage);
    if (Array.isArray(o.metaMessages)) stack.push(...o.metaMessages);
  }
  return { dataHex, errorName, embedded, raw };
}

/** Decode a standard Error(string)/Panic(uint256) blob into a readable reason. */
function decodeStandardRevert(dataHex?: string): string | undefined {
  if (!dataHex) return undefined;
  const sel = dataHex.slice(0, 10);
  if (sel !== SELECTOR_STRING_ERROR && sel !== SELECTOR_PANIC) return undefined;
  try {
    const dec = decodeErrorResult({ abi: STANDARD_ERROR_ABI, data: dataHex as Hex });
    if (dec.errorName === "Error") return String(dec.args?.[0] ?? "");
    if (dec.errorName === "Panic") return `Panic(0x${(dec.args?.[0] as bigint).toString(16)})`;
  } catch {
    /* fall through — undecodable blob */
  }
  return undefined;
}

/** Keep raw error compact and free of anything sensitive. */
function clip(s: string): string {
  return s.length > 160 ? s.slice(0, 160) : s;
}

/**
 * Decode a revert (a viem error, a raw revert-data hex string, or any thrown
 * value) into a structured, human-readable explanation.
 */
export function decodeRevert(error: unknown): DecodedRevert {
  const { dataHex, errorName, embedded, raw } = scan(error);
  const dataSelector = dataHex ? dataHex.slice(0, 10) : undefined;

  // A standard string/panic revert carries the real reason (e.g. Uniswap's
  // "Price slippage check") — surface it verbatim.
  const reason = decodeStandardRevert(dataHex);
  if (reason && dataSelector === SELECTOR_STRING_ERROR) {
    const isSlippage = /slippage|price/i.test(reason);
    return {
      errorName: null,
      humanMessage: `The call reverted: "${reason}".`,
      suggestedAction: isSlippage
        ? "The amounts did not match the pool's current ratio (or the price moved past your slippage). Re-quote and retry with ratio-matched amounts or a higher slippage tolerance."
        : "Inspect the failing call — a lower-level contract rejected it with this message.",
      rawError: clip(reason),
    };
  }

  // Match a BVCC / OZ error: by errorName, by the authoritative data selector,
  // by any KNOWN embedded selector, then by name mentioned in the message.
  let entry: Entry | undefined;
  if (errorName) entry = byName.get(errorName);
  if (!entry && dataSelector) entry = bySelector.get(dataSelector);
  if (!entry) for (const s of embedded) if ((entry = bySelector.get(s))) break;
  if (!entry && raw) {
    for (const e of ENTRIES) {
      if (raw.includes(e.name)) {
        entry = e;
        break;
      }
    }
  }

  if (entry) {
    return {
      errorName: entry.name,
      humanMessage: entry.humanMessage,
      suggestedAction: entry.suggestedAction,
      // Prefer the authoritative data selector; else the matched error's own selector.
      rawError: dataSelector ?? toFunctionSelector(entry.signature).toLowerCase(),
    };
  }

  // Unknown. Surface the authoritative data (even if unrecognized, like 0xdeadbeef)
  // or the panic code or the message — but NOT an untrusted embedded hex.
  const rawError = dataSelector ?? reason ?? errorName ?? (raw ? clip(raw) : "unknown");
  return {
    errorName: errorName ?? null,
    humanMessage: "The transaction reverted for an unrecognized reason.",
    suggestedAction:
      "Run a dry-run/simulation, verify allowances and whitelists, or inspect the contract on the explorer.",
    rawError,
  };
}

/** Exposed for tests. */
export const __errorSelectors = bySelector;
