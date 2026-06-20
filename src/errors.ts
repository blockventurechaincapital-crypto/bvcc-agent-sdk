import { toFunctionSelector } from "viem";

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

const SELECTOR_RE = /0x[0-9a-fA-F]{8}/;

function scan(error: unknown): { selector?: string; errorName?: string; raw: string } {
  let raw = "";
  let selector: string | undefined;
  let errorName: string | undefined;
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];

  while (stack.length) {
    const node = stack.pop();
    if (node == null || seen.has(node)) continue;
    seen.add(node);

    if (typeof node === "string") {
      if (!raw) raw = node;
      const m = node.match(SELECTOR_RE);
      if (m && !selector) selector = m[0].slice(0, 10).toLowerCase();
      continue;
    }
    if (typeof node !== "object") continue;

    const o = node as Record<string, unknown>;
    if (typeof o.errorName === "string" && !errorName) errorName = o.errorName;
    if (typeof o.data === "string" && o.data.startsWith("0x") && !selector) {
      selector = o.data.slice(0, 10).toLowerCase();
    }
    if (o.data && typeof o.data === "object") {
      const dn = (o.data as Record<string, unknown>).errorName;
      if (typeof dn === "string" && !errorName) errorName = dn;
    }
    if (typeof o.signature === "string" && o.signature.startsWith("0x") && !selector) {
      selector = o.signature.slice(0, 10).toLowerCase();
    }
    if (typeof o.shortMessage === "string" && !raw) raw = o.shortMessage;

    stack.push(o.cause, o.error, o.message, o.details, o.shortMessage);
    if (Array.isArray(o.metaMessages)) stack.push(...o.metaMessages);
  }
  return { selector, errorName, raw };
}

/** Keep raw error compact and free of anything sensitive. */
function safeRaw(selector?: string, errorName?: string, raw?: string): string {
  if (selector) return selector;
  if (errorName) return errorName;
  if (raw) return raw.slice(0, 160);
  return "unknown";
}

/**
 * Decode a revert (a viem error, a raw revert-data hex string, or any thrown
 * value) into a structured, human-readable explanation.
 */
export function decodeRevert(error: unknown): DecodedRevert {
  const { selector, errorName, raw } = scan(error);

  let entry: Entry | undefined;
  if (errorName) entry = byName.get(errorName);
  if (!entry && selector) entry = bySelector.get(selector);
  if (!entry && raw) {
    for (const e of ENTRIES) {
      if (raw.includes(e.name)) {
        entry = e;
        break;
      }
    }
  }

  const rawError = safeRaw(selector, errorName ?? entry?.name, raw);
  if (entry) {
    return {
      errorName: entry.name,
      humanMessage: entry.humanMessage,
      suggestedAction: entry.suggestedAction,
      rawError,
    };
  }
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
