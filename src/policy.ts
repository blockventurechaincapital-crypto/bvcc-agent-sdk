/**
 * Call policies — the V3 permission layer.
 *
 * Why this exists: before V3, an agent's reach was fully described by its
 * permission struct (tokens, protocols, recipients, budgets). V3 added a second,
 * independent gate for Case-3 (DeFi) calls: every `(target, selector)` pair is
 * DENIED unless the wallet owner registered a policy for it, and that policy can
 * pin calldata words so funds cannot be redirected away from the wallet.
 *
 * An SDK that only reads permissions therefore sees half the picture: it will
 * report a swap as possible and then watch it revert. This module is the missing
 * half — reading a policy, decoding what it enforces, and asking the registry
 * whether a deep validator is actually live.
 *
 * Nothing here can grant anything. Policies are written by the wallet owner with
 * Face ID / WebAuthn; the registry is governed by BVCC behind a 48h timelock. All
 * of this is read-only, and the contract stays the source of truth.
 */
import type { Address, Hex, PublicClient } from "viem";

import { agentWalletAbi, validatorRegistryAbi } from "./abi.js";

/**
 * Selectors the swap helpers need a policy for, on V3 wallets.
 * Kept here so pre-flight and error explanation agree on one source.
 */
export const SELECTORS = {
  /** SwapRouter02.exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) */
  exactInputSingle: "0x04e45aaf",
  /** UniversalRouter.execute(bytes,bytes[],uint256) */
  urExecute: "0x3593564c",
  /** Permit2.approve(address,address,uint160,uint48) */
  permit2Approve: "0x87517c45",
} as const satisfies Record<string, Hex>;

/** Policy word bit 255 — the selector is permitted at all. */
export const POLICY_ALLOWED = 1n << 255n;
/** Policy word bit 254 — defer to the validator registry for deep calldata checks. */
export const POLICY_DEEP = 1n << 254n;

const PIN_WALLET_SHIFT = 192n;
const PIN_PROTOCOL_SHIFT = 160n;
const BITMAP_WIDTH = 32;

/** Which wallet generation a given address is. */
export type WalletVersion = "v2" | "v3";

/** A policy word, decoded into what it actually enforces. */
export interface DecodedPolicy {
  /** Raw word as stored on-chain. */
  raw: bigint;
  /** False = this selector is denied outright (policy never registered, or revoked). */
  allowed: boolean;
  /** True = the registry is consulted for deep calldata validation. */
  deep: boolean;
  /** Calldata word indices (0-based, after the selector) that must equal the wallet. */
  pinnedToWallet: number[];
  /** Calldata word indices that must be one of the agent's allowed protocols. */
  pinnedToProtocol: number[];
}

/** Decode a policy word into its enforced constraints. */
export function decodePolicy(raw: bigint): DecodedPolicy {
  const bitmap = (shift: bigint): number[] => {
    const bits = (raw >> shift) & 0xffffffffn;
    const words: number[] = [];
    for (let i = 0; i < BITMAP_WIDTH; i++) {
      if ((bits >> BigInt(i)) & 1n) words.push(i);
    }
    return words;
  };
  return {
    raw,
    allowed: (raw & POLICY_ALLOWED) !== 0n,
    deep: (raw & POLICY_DEEP) !== 0n,
    pinnedToWallet: bitmap(PIN_WALLET_SHIFT),
    pinnedToProtocol: bitmap(PIN_PROTOCOL_SHIFT),
  };
}

/**
 * Plain-language summary of a decoded policy, for agent-facing messages.
 * Written so an agent that reads it knows what to change about its calldata.
 */
export function describePolicy(p: DecodedPolicy): string {
  if (!p.allowed) return "Denied: the wallet owner has not registered a policy for this function.";
  const parts: string[] = ["Allowed"];
  if (p.pinnedToWallet.length > 0) {
    const w = p.pinnedToWallet.join(", ");
    parts.push(`argument word${p.pinnedToWallet.length > 1 ? "s" : ""} ${w} must be the wallet address`);
  }
  if (p.pinnedToProtocol.length > 0) {
    const w = p.pinnedToProtocol.join(", ");
    parts.push(`argument word${p.pinnedToProtocol.length > 1 ? "s" : ""} ${w} must be a whitelisted protocol`);
  }
  if (p.deep) parts.push("calldata is checked by the on-chain validator for this protocol");
  return parts.join("; ") + ".";
}

/**
 * Which wallet generation lives at `wallet`.
 *
 * `walletType()` cannot answer this — it returns 1 for an agent wallet in BOTH V2
 * and V3. So we probe `getCallPolicy`, which only exists on V3: on V2 the call
 * hits no function and reverts. A harmless zero-argument read is used, and the
 * result is cached because a deployed wallet never changes generation.
 */
const versionCache = new Map<string, WalletVersion>();

export async function detectWalletVersion(
  publicClient: PublicClient,
  wallet: Address,
): Promise<WalletVersion> {
  const key = `${publicClient.chain?.id ?? 0}:${wallet.toLowerCase()}`;
  const cached = versionCache.get(key);
  if (cached) return cached;

  let version: WalletVersion;
  try {
    await publicClient.readContract({
      address: wallet,
      abi: agentWalletAbi,
      functionName: "getCallPolicy",
      args: ["0x0000000000000000000000000000000000000000", "0x00000000"],
    });
    version = "v3";
  } catch {
    // Absent function on V2. A transport failure would land here too, so this is
    // deliberately not cached as a negative result below.
    version = "v2";
  }
  if (version === "v3") versionCache.set(key, version);
  return version;
}

/** Read one policy word. Returns 0n on V2 wallets, where policies do not exist. */
export async function readCallPolicy(
  publicClient: PublicClient,
  wallet: Address,
  target: Address,
  selector: Hex,
): Promise<bigint> {
  try {
    return (await publicClient.readContract({
      address: wallet,
      abi: agentWalletAbi,
      functionName: "getCallPolicy",
      args: [target, selector],
    })) as bigint;
  } catch {
    return 0n;
  }
}

/** Read and decode a policy in one step. */
export async function getPolicy(
  publicClient: PublicClient,
  wallet: Address,
  target: Address,
  selector: Hex,
): Promise<DecodedPolicy> {
  return decodePolicy(await readCallPolicy(publicClient, wallet, target, selector));
}

/**
 * The validator currently active for `target`, or null if there is none.
 *
 * Null is the meaningful case: it means DEEP-gated calls to that protocol fail
 * closed. It covers both "never registered" and "frozen by BVCC via the registry
 * kill-switch" — indistinguishable on-chain, and identical in consequence: the
 * agent cannot use that protocol and retrying will not help.
 */
export async function getActiveValidator(
  publicClient: PublicClient,
  registry: Address,
  target: Address,
): Promise<Address | null> {
  try {
    const v = (await publicClient.readContract({
      address: registry,
      abi: validatorRegistryAbi,
      functionName: "validators",
      args: [target],
    })) as Address;
    return v === "0x0000000000000000000000000000000000000000" ? null : v;
  } catch {
    return null;
  }
}

/** Why a Case-3 call is (or would be) rejected by the policy layer. */
export interface PolicyDiagnosis {
  /** True when nothing in the policy layer blocks this call. */
  ok: boolean;
  /** Machine-readable cause; null when ok. */
  reason:
    | "no-policy"
    | "no-validator"
    | "validator-rejected"
    | "pin-mismatch-possible"
    | null;
  humanMessage: string;
  suggestedAction: string;
  /** True when a different calldata could succeed; false when the agent is simply not allowed. */
  retryable: boolean;
  policy: DecodedPolicy;
}

/**
 * Explain a policy-layer rejection, or check one before sending.
 *
 * The case worth the extra round-trip is `PolicyValidationFailed`, which carries
 * two opposite meanings behind one selector:
 *
 *   - no validator registered for the target (never added, or frozen by BVCC's
 *     kill-switch) → nothing the agent can do; retrying forever is pointless.
 *   - a validator IS active and refused this calldata → the agent can fix it,
 *     usually by pointing the recipient back at the wallet.
 *
 * Telling an autonomous agent which of the two it hit is the difference between
 * a clean stop and an infinite retry loop.
 */
export async function diagnosePolicy(
  publicClient: PublicClient,
  wallet: Address,
  target: Address,
  selector: Hex,
  opts: { registry?: Address; value?: bigint; data?: Hex } = {},
): Promise<PolicyDiagnosis> {
  const policy = await getPolicy(publicClient, wallet, target, selector);

  if (!policy.allowed) {
    return {
      ok: false,
      reason: "no-policy",
      humanMessage:
        "The wallet owner has not registered a call policy for this function, so it is denied by default.",
      suggestedAction:
        "Ask the owner to add this protocol to the agent in the dashboard. Retrying will not help.",
      retryable: false,
      policy,
    };
  }

  if (policy.deep) {
    if (!opts.registry) {
      return {
        ok: false,
        reason: "no-validator",
        humanMessage:
          "This function needs deep validation, but no validator registry is known for this network.",
        suggestedAction: "Use a network where wallet V3 is deployed, or pass the registry address.",
        retryable: false,
        policy,
      };
    }
    const validator = await getActiveValidator(publicClient, opts.registry, target);
    if (!validator) {
      return {
        ok: false,
        reason: "no-validator",
        humanMessage:
          "No validator is active for this protocol, so deep-validated calls to it fail closed. It was either never registered or has been frozen by BVCC.",
        suggestedAction:
          "Use a different protocol for this action (e.g. SwapRouter02 instead of the Universal Router). Retrying will not help until BVCC registers a validator.",
        retryable: false,
        policy,
      };
    }
    if (opts.data) {
      const passes = await wouldPassDeepValidation(
        publicClient,
        opts.registry,
        wallet,
        target,
        opts.value ?? 0n,
        opts.data,
      );
      if (!passes) {
        return {
          ok: false,
          reason: "validator-rejected",
          humanMessage:
            "The validator refused this calldata — an unsupported command, or a recipient other than the wallet.",
          suggestedAction:
            "Send every output back to the wallet address and use only supported swap commands.",
          retryable: true,
          policy,
        };
      }
    }
  }

  return {
    ok: true,
    reason: null,
    humanMessage: describePolicy(policy),
    suggestedAction: "",
    retryable: true,
    policy,
  };
}

/**
 * Ask the registry whether a specific call would pass deep validation, without
 * sending it. Useful to explain a `PolicyValidationFailed` before burning gas.
 * Fails closed: any read problem returns false, matching on-chain behaviour.
 */
export async function wouldPassDeepValidation(
  publicClient: PublicClient,
  registry: Address,
  wallet: Address,
  target: Address,
  value: bigint,
  data: Hex,
): Promise<boolean> {
  try {
    return (await publicClient.readContract({
      address: registry,
      abi: validatorRegistryAbi,
      functionName: "validate",
      args: [wallet, target, value, data],
    })) as boolean;
  } catch {
    return false;
  }
}
