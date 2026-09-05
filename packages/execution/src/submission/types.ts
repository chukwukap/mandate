import type { Hex } from "@mandate/contracts";
import type { Leg } from "../lifecycle.js";

/**
 * The transaction pipeline's vocabulary and its ports.
 *
 * Every chain capability the pipeline needs is declared here as a narrow method rather than
 * taken as a viem client, for two reasons. The obvious one is testability: the whole
 * pipeline runs against plain objects, so crash ordering and nonce conflicts are exercised
 * without a node. The load-bearing one is that `@mandate/execution` must not gain a
 * dependency on a signing library. This package decides WHETHER to sign; it has no way to
 * produce a signature on its own, and that separation is what makes "the key lives in one
 * place" enforceable rather than a convention.
 */

/** A call this process is willing to originate. `value` is wei and is almost always zero. */
export type SubmissionCall = {
  readonly to: Hex;
  readonly data: Hex;
  readonly value?: bigint | undefined;
};

/** Signed bytes plus everything needed to find them again after a crash. */
export type SignedTransaction = {
  readonly signer: Hex;
  readonly nonce: number;
  readonly rawTransaction: Hex;
  readonly hash: Hex;
};

/**
 * What the pipeline knows about one journal row.
 *
 * A structural subset of `TransactionRow`, so a row read straight out of the database
 * satisfies it. `status` is the journal's own three-state — `signed` means bytes exist and
 * may or may not have reached the chain, which is the only honest thing to say about a
 * transaction between a durable write and a confirmed receipt.
 */
export type JournalEntry = {
  readonly id: string;
  readonly executionId: string;
  readonly leg: string;
  readonly signer: string;
  readonly nonce: number;
  readonly hash: string;
  readonly rawTransaction: string;
  readonly status: string;
};

/** A journal row that is definitely durable. Only this can be broadcast; see `Submitter`. */
export type RecordedSubmission = JournalEntry & { readonly recorded: true };

export interface SubmissionChain {
  /**
   * The chain the RPC is actually serving.
   *
   * Checked before every signature, not once at startup. An endpoint that is failed over,
   * reconfigured or simply pointed at a testnet reports different nonces for the same key;
   * signing against those and then broadcasting to mainnet produces a transaction at a
   * nonce mainnet has already consumed, or — worse — a gap that parks the real one.
   */
  chainId(): Promise<number>;
  /** `eth_getTransactionCount` at `latest` and at `pending`, in that order, for one key. */
  transactionCounts(signer: Hex): Promise<{ latest: number; pending: number }>;
  /** `eth_call` from the signer. Must throw on revert; must not swallow transport faults. */
  simulate(input: { signer: Hex; call: SubmissionCall }): Promise<void>;
  /** Native balance in wei. Gas money, not user funds. */
  balance(signer: Hex): Promise<bigint>;
  /** Current fee ceiling in wei per gas, for the affordability check only. */
  maxFeePerGas(): Promise<bigint>;
  /** Sign locally. The implementation owns the key; this package never sees it. */
  sign(input: {
    signer: Hex;
    call: SubmissionCall;
    nonce: number;
  }): Promise<SignedTransaction>;
  /**
   * `eth_sendRawTransaction`.
   *
   * Must be idempotent for identical bytes — resending a transaction that is already known
   * to the node is a no-op that returns the same hash, and the pipeline relies on that
   * being harmless. It is re-signing that must never happen, not re-sending.
   */
  send(rawTransaction: Hex): Promise<void>;
}

export interface SubmissionJournal {
  /**
   * Every row this worker has ever written for `signer`, cheapest sufficient subset.
   *
   * "Every row" and not "this order's rows": the nonce belongs to the key, which is shared
   * across all orders and all owners, so a decision made from one order's journal is a
   * decision made with half the facts.
   */
  entries(signer: Hex): Promise<readonly JournalEntry[]>;
  /**
   * Commit signed bytes durably, and return them as a `RecordedSubmission`.
   *
   * The implementation MUST enforce uniqueness on `(signer, nonce)` and on
   * `(executionId, leg)` — `mandate_v2.transactions` does both — and must reject rather
   * than overwrite. This method is the commit point of the whole pipeline: after it
   * returns, a transaction may reach the chain at any time, including after a crash, and
   * before it returns nothing may be sent.
   */
  record(input: {
    executionId: string;
    userId: string;
    leg: Leg;
    signed: SignedTransaction;
  }): Promise<RecordedSubmission>;
}

/**
 * Why the pipeline declined, as a stable code.
 *
 * The split that matters is between codes a timer can clear and codes it cannot; see
 * `retryable` below. Naming them individually rather than returning a boolean means the
 * worker's job layer can log a specific reason and an operator can alert on one.
 */
export type SubmissionRefusalCode =
  /** The RPC is not serving Base. Nothing is signed against an unidentified chain. */
  | "wrong-network"
  /** Simulation reverted. The transaction would fail on chain; sending it burns gas. */
  | "would-revert"
  /** Simulation could not be performed. Unknown, therefore not sent. */
  | "simulation-unavailable"
  /** Another transaction from this key is unaccounted for. See `nonce.ts`. */
  | "nonce-conflict"
  /** The key cannot pay for the transactions this order still needs. */
  | "insufficient-gas"
  /** The journal already holds this leg. Reconcile the existing row instead of signing. */
  | "already-journaled"
  /** The durable write failed. Nothing was broadcast, which is the point. */
  | "not-recorded"
  /** The chain could not be reached at all. */
  | "chain-unavailable";

export type SubmissionRefusal = {
  readonly code: SubmissionRefusalCode;
  /** One sentence, safe to log and to store in `executions.reason`. Never an upstream message. */
  readonly detail: string;
};

/**
 * `prepared` — signed and durably journaled, not yet broadcast. The order advances on the
 *              next cycle, which is also what happens after a crash at this exact point.
 * `broadcast` — the same bytes reached the node. NOT a receipt and NOT success.
 * `refused`   — a deliberate decision not to send. `retryable` says whether waiting helps.
 */
export type SubmissionResult =
  | { readonly status: "prepared"; readonly entry: RecordedSubmission }
  | { readonly status: "broadcast"; readonly entry: RecordedSubmission }
  | { readonly status: "refused"; readonly refusal: SubmissionRefusal };

/**
 * Whether a refusal can clear on its own.
 *
 * `would-revert` is the one worth arguing about, and it is deliberately terminal. A revert
 * is the chain saying the transaction is invalid against current state; retrying it on a
 * timer means paying gas repeatedly to be told the same thing, and — for the `fund` leg —
 * consuming spend-permission allowance attempts while the user watches an order fail
 * silently. If the state that caused the revert changes, the order is re-prepared from
 * scratch on a later tick with a fresh quote, which is the correct path.
 */
export function retryable(code: SubmissionRefusalCode): boolean {
  return code === "simulation-unavailable" || code === "chain-unavailable";
}
