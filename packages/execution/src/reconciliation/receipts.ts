import type { JournalEntry } from "../submission/types.js";
import { type LogRecord, totalTransferred } from "./logs.js";

/**
 * Turning a receipt into a verdict.
 *
 * "Did it work?" has four answers here, not two, and the fourth is the one that earns its
 * keep. `ambiguous` means the chain and the journal disagree, or the chain declined to say
 * — and it is never collapsed into `pending` or `reverted`, because both of those are
 * claims this code would not be entitled to make. A nonce consumed with no receipt for our
 * bytes is not "still waiting"; a receipt in a block that is no longer canonical is not
 * "confirmed". Each of those resolves to an operator, which is slow and correct, rather
 * than to a retry, which is fast and occasionally catastrophic.
 */

/** Structurally satisfied by viem's `TransactionReceipt` (and its OP-stack extension). */
export type ReceiptRecord = {
  readonly transactionHash: string;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly status: "success" | "reverted";
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  /** OP-stack L1 data fee, in wei. Absent on a client that does not surface it. */
  readonly l1Fee?: bigint | null | undefined;
  readonly logs: readonly LogRecord[];
};

/** The shape `transactions.evidence` already holds. Amounts are integer strings. */
export type TransferEvidence = {
  readonly token: string;
  readonly recipient: string;
  readonly amount: string;
  readonly from?: string | undefined;
};

export type Confirmation = "pending" | "confirmed" | "reverted" | "ambiguous";

export type ReceiptVerdict = {
  readonly outcome: Confirmation;
  /** Blocks including the one it mined in. Null when there is no receipt. */
  readonly depth: number | null;
  /** One operator-readable sentence. Contains no upstream error text. */
  readonly detail: string;
};

export type ReceiptFacts = {
  readonly receipt: ReceiptRecord | null;
  /** The hash the journal recorded for these bytes. */
  readonly hash: string;
  /** Current head. */
  readonly head: bigint;
  /** `WORKER_CONFIRMATIONS`. */
  readonly confirmations: number;
  /**
   * The block hash the chain reports for `receipt.blockNumber` right now.
   *
   * Supplying it is what turns a receipt read into a canonicality check: a receipt fetched
   * by hash is served from an index that can outlive the block it points at, so a reorged
   * transaction keeps answering `getTransactionReceipt` with a block that is no longer on
   * the canonical chain. Omitting this leaves that hole open, and the verdict says so.
   */
  readonly canonicalBlockHash?: string | null | undefined;
  /** Journal nonce, and the signer's consumed-nonce count. Together they explain a miss. */
  readonly nonce?: number | undefined;
  readonly signerLatestNonce?: number | undefined;
  /** Expected transfer. Absent for legs that move nothing, such as `approve`. */
  readonly evidence?: TransferEvidence | null | undefined;
  /**
   * Whether the transfer must match `amount` exactly rather than merely reach it.
   *
   * Exact for every leg whose amount this system chose — a `fund` pull, a `refund`
   * transfer. Not exact for a `swap`, whose output is whatever the pool paid: it is bounded
   * below by `amountOutMinimum` and has no upper bound, and demanding equality there would
   * declare every favourable fill ambiguous.
   */
  readonly exact?: boolean | undefined;
};

/**
 * What a transaction cost its sender, in wei.
 *
 * Two things a naive `gasUsed * gasPrice` gets wrong, both of which understate:
 *
 *  - Base is an OP-stack rollup, so every transaction also pays an L1 fee to post its
 *    calldata, and that fee is not in `gasUsed` at all. On a cheap L2 call it is routinely
 *    the larger half of the bill.
 *  - A REVERTED transaction still costs gas. Excluding failures from a cost total produces
 *    a running expense figure that is wrong in exactly the periods when it matters.
 */
export function transactionCost(receipt: ReceiptRecord): bigint {
  return receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n);
}

/**
 * Classify one submission against the chain.
 *
 * Order matters: the cheapest disqualifying fact is checked first, and every branch that
 * cannot prove something returns `ambiguous` rather than the convenient answer.
 */
export function classifyReceipt(facts: ReceiptFacts): ReceiptVerdict {
  const { receipt } = facts;
  if (!receipt) {
    // No receipt yet. Whether that is normal depends entirely on the nonce: if the key's
    // consumed count has moved past this transaction's nonce, then SOMETHING mined at that
    // nonce and it was not these bytes, because these bytes have no receipt. Calling that
    // "pending" would leave the worker waiting for a transaction that can never appear.
    if (
      facts.nonce !== undefined &&
      facts.signerLatestNonce !== undefined &&
      facts.signerLatestNonce > facts.nonce
    )
      return {
        outcome: "ambiguous",
        depth: null,
        detail: `Nonce ${facts.nonce} has been consumed but no receipt exists for the journaled hash; another transaction occupied it.`,
      };
    return { outcome: "pending", depth: null, detail: "No receipt yet." };
  }

  if (receipt.transactionHash.toLowerCase() !== facts.hash.toLowerCase())
    return {
      outcome: "ambiguous",
      depth: null,
      detail: "The receipt belongs to a different transaction than the journaled bytes.",
    };

  if (
    facts.canonicalBlockHash !== undefined &&
    facts.canonicalBlockHash !== null &&
    facts.canonicalBlockHash.toLowerCase() !== receipt.blockHash.toLowerCase()
  )
    return {
      outcome: "ambiguous",
      depth: null,
      detail: `The receipt names block ${receipt.blockHash} at height ${receipt.blockNumber}, but that height is now a different block.`,
    };

  // Inclusive: a transaction in the head block has one confirmation, not zero.
  const depth = Number(facts.head - receipt.blockNumber + 1n);
  if (depth < facts.confirmations)
    return {
      outcome: "pending",
      depth,
      detail: `Mined with ${depth} of ${facts.confirmations} confirmations.`,
    };

  if (receipt.status === "reverted")
    return { outcome: "reverted", depth, detail: "The transaction reverted on chain." };

  const evidence = facts.evidence;
  if (!evidence) return { outcome: "confirmed", depth, detail: "Confirmed." };

  // Evidence is checked from the logs, not from the fact that the transaction succeeded. A
  // successful call proves the EVM did not revert; it does not prove the tokens this order
  // depends on actually moved to the address this order expects.
  const moved = totalTransferred(receipt.logs, {
    token: evidence.token,
    to: evidence.recipient,
    ...(evidence.from === undefined ? {} : { from: evidence.from }),
  });
  const expected = BigInt(evidence.amount);
  if (moved < expected)
    return {
      outcome: "ambiguous",
      depth,
      detail: `The transaction succeeded but moved ${moved} of an expected ${expected} to ${evidence.recipient.toLowerCase()}.`,
    };
  if (facts.exact !== false && moved !== expected)
    return {
      outcome: "ambiguous",
      depth,
      detail: `The transaction moved ${moved} where exactly ${expected} was expected.`,
    };
  return { outcome: "confirmed", depth, detail: "Confirmed with matching transfer evidence." };
}

export type SubmissionMatch = {
  readonly entry: JournalEntry;
  readonly receipt: ReceiptRecord | null;
  readonly verdict: ReceiptVerdict;
  /**
   * True when a leg the journal already recorded as settled no longer classifies the same
   * way. Confirmed becoming reverted, or either becoming ambiguous, means a receipt this
   * system already acted on has changed underneath it — a reorg deep enough to pass the
   * confirmation threshold, or a database that is not the one those receipts were written
   * against. Nothing automatic recovers from that.
   */
  readonly changed: boolean;
};

export type MatchResult = {
  readonly matches: readonly SubmissionMatch[];
  /**
   * Receipts that no journal row claims.
   *
   * Empty when receipts were fetched by journal hash, which is the normal path. Non-empty
   * only when a caller gathered receipts by scanning the signer's transactions, and then it
   * is the highest-signal finding available: bytes this worker never signed were sent from
   * the spender key.
   */
  readonly unmatched: readonly ReceiptRecord[];
};

const SETTLED = new Set(["confirmed", "reverted"]);

/**
 * Pair journal rows with receipts and classify each one.
 *
 * Matching is by transaction hash and by nothing else. Matching by nonce would look
 * tempting — the journal has one and so does every transaction — but a nonce identifies a
 * SLOT, not a transaction, and the whole class of incidents this system worries about is
 * exactly the case where something else occupies our slot. Hash matching cannot make that
 * mistake: if the hashes differ, the transaction is not ours, full stop.
 */
export function matchSubmissions(input: {
  readonly entries: readonly JournalEntry[];
  readonly receipts: readonly ReceiptRecord[];
  readonly head: bigint;
  readonly confirmations: number;
  readonly canonicalBlockHashes?: ReadonlyMap<string, string> | undefined;
  readonly signerLatestNonce?: number | undefined;
  readonly evidence?: ReadonlyMap<string, TransferEvidence | null> | undefined;
  readonly exact?: ReadonlyMap<string, boolean> | undefined;
}): MatchResult {
  const byHash = new Map<string, ReceiptRecord>();
  for (const receipt of input.receipts) byHash.set(receipt.transactionHash.toLowerCase(), receipt);
  const claimed = new Set<string>();
  const matches: SubmissionMatch[] = [];
  for (const entry of input.entries) {
    const hash = entry.hash.toLowerCase();
    const receipt = byHash.get(hash) ?? null;
    if (receipt) claimed.add(hash);
    const canonical = receipt
      ? input.canonicalBlockHashes?.get(receipt.blockNumber.toString())
      : undefined;
    const verdict = classifyReceipt({
      receipt,
      hash: entry.hash,
      head: input.head,
      confirmations: input.confirmations,
      ...(canonical === undefined ? {} : { canonicalBlockHash: canonical }),
      nonce: entry.nonce,
      ...(input.signerLatestNonce === undefined
        ? {}
        : { signerLatestNonce: input.signerLatestNonce }),
      ...(input.evidence?.has(entry.id) ? { evidence: input.evidence.get(entry.id) } : {}),
      ...(input.exact?.has(entry.id) ? { exact: input.exact.get(entry.id) } : {}),
    });
    matches.push({
      entry,
      receipt,
      verdict,
      changed: SETTLED.has(entry.status) && verdict.outcome !== entry.status,
    });
  }
  return {
    matches,
    unmatched: input.receipts.filter((r) => !claimed.has(r.transactionHash.toLowerCase())),
  };
}
