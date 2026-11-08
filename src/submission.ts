/**
 * Sending an agent operation without ever doing it twice.
 *
 * The danger is a send that fails *after* the node accepted it (a timeout, a dropped
 * connection): the caller sees an error, repeats the operation, and both run. So:
 *
 *   - the transaction is signed locally first, so its hash is known before it is sent;
 *   - when sending throws, the client looks that hash up on-chain before saying anything;
 *   - only an operation that certainly did not go in is reported as a failure;
 *   - one that may be on-chain is reported as such, with its hash, and `retryable: false`;
 *   - the nonce comes from the confirmed transaction count, so a repeat sent while the
 *     first one is still pending carries the same nonce and the chain takes only one;
 *   - operations from one client go out one at a time, each after the previous one is
 *     confirmed, and nothing is ever re-sent automatically.
 */
import type { Hex } from "viem";

import type { DecodedRevert } from "./errors.js";

/** An operation whose outcome is not a plain failure: it may be on-chain. */
export class SubmissionError extends Error {
  readonly bvccDecoded: DecodedRevert;
  constructor(
    decoded: DecodedRevert,
    /** The transaction hash, when the operation may be on-chain. */
    readonly txHash?: Hex,
  ) {
    super(decoded.humanMessage);
    this.name = "SubmissionError";
    this.bvccDecoded = decoded;
  }
}

/** Sent, but not confirmed within the wait. It may still go through. */
export function notYetConfirmed(hash: Hex): DecodedRevert {
  return {
    errorName: "NotYetConfirmed",
    humanMessage: `The operation was sent (${hash}) but is not confirmed yet. It may still go through.`,
    suggestedAction:
      `Do not repeat it. Check this transaction hash, or the balances, before doing anything else; ` +
      `the agent's next operation waits for it.`,
    rawError: "receipt wait timed out",
    retryable: false,
  };
}

/** Sending threw and the transaction could not be found: it may or may not be on-chain. */
export function submissionUnknown(hash: Hex): DecodedRevert {
  return {
    errorName: "SubmissionUnknown",
    humanMessage:
      `The network did not confirm receiving the operation (${hash}), and it cannot be found yet. ` +
      `It may still have been sent.`,
    suggestedAction:
      `Do not repeat it yet. Check this transaction hash, or the balances, in a minute; ` +
      `repeat only once it is clear the operation is not on-chain.`,
    rawError: "send failed, transaction not found",
    retryable: false,
  };
}

/** Another transaction of this agent took the nonce first: this one certainly did not run. */
export function nonceTaken(): DecodedRevert {
  return {
    errorName: "NonceTaken",
    humanMessage:
      "This operation was not sent: another operation of this agent was confirmed just before it " +
      "(for example the same operation sent twice, or another program using the agent's key).",
    suggestedAction:
      "Check the balances first: the other operation may be this same one. Repeat it only if it is " +
      "clearly still missing.",
    rawError: "nonce too low",
    retryable: false,
  };
}

/** The agent's previous operation is still pending, so this one was not sent. */
export function previousPending(hash: Hex): DecodedRevert {
  return {
    errorName: "PreviousStillPending",
    humanMessage: `The agent's previous operation (${hash}) is not confirmed yet, so this one was not sent.`,
    suggestedAction: `Wait until ${hash} is confirmed, then send this operation.`,
    rawError: "previous transaction pending",
    retryable: true,
  };
}

/** True when the node says the nonce is already used. */
export function isNonceTooLow(e: unknown): boolean {
  const msg = (e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ""}` : String(e)).toLowerCase();
  return (
    msg.includes("nonce too low") ||
    msg.includes("lower than the current nonce") ||
    msg.includes("nonce has already been used") ||
    msg.includes("nonce is too low")
  );
}
