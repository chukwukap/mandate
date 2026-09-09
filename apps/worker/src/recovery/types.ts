import type { Hex } from "@mandate/contracts";
import type { ExecutionRow, TransactionRow } from "@mandate/database";
import type { Leg, Observation } from "@mandate/execution";
import type { PublicClient, Transport } from "viem";
import type { base } from "viem/chains";

/**
 * Recovery's view of the chain.
 *
 * `WorkerChain` satisfies this structurally, so nothing in chain.ts changes. Recovery
 * deliberately does NOT depend on `Executor` as a whole: it must never reach `prepare`,
 * which is the only method that signs. The narrow surface is the enforcement.
 *
 * `broadcast` is included because resending BYTES THAT ARE ALREADY JOURNALED is the same
 * operation Lifecycle performs on every poll, and `WorkerChain.broadcast` re-checks
 * `keccak256(rawTransaction) === hash` before it sends. That check, not this interface,
 * is what makes a resend safe.
 */
export interface RecoveryChain {
  readonly client: PublicClient<Transport, typeof base>;
  observe(transaction: TransactionRow): Promise<Observation>;
  broadcast(transaction: TransactionRow): Promise<void>;
}

/** Structurally satisfied by a pino logger, matching apps/worker/src/jobs/types.ts. */
export interface RecoveryLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * What the chain says about the strategy's wallet right now.
 *
 * `latest` is the transaction count at the latest block: every nonce strictly below it has
 * been consumed by a mined transaction. `pending` additionally counts what this node holds
 * in its mempool. `pending === latest` therefore means the node is holding nothing — which
 * is how a dropped transaction is told apart from one that is merely waiting.
 */
export type NonceState = {
  readonly signer: Hex;
  readonly latest: number;
  readonly pending: number;
  readonly blockNumber: bigint;
};

/**
 * What this worker has ever committed for that key, read across every owner.
 *
 * `ceiling` is one past the highest nonce in any journal, so `latest > ceiling` proves a
 * nonce was consumed by bytes this worker never signed. `unsettled` lists the nonces whose
 * journal rows are still `signed`, which is what a `pending > latest` reading has to be
 * explained by before it can be called foreign.
 */
export type SignerJournal = {
  readonly ceiling: number;
  readonly unsettled: readonly number[];
  /** False when owner paging hit its bound, so `ceiling` is a lower bound, not a fact. */
  readonly complete: boolean;
};

/** A decoded call. `unknown` is a real answer, not a failure: an operator still learns the target. */
export type KnownCall =
  | {
      readonly kind: "erc20-approve";
      readonly token: Hex;
      readonly spender: Hex;
      readonly amount: string;
    }
  | {
      readonly kind: "erc20-transfer";
      readonly token: Hex;
      readonly recipient: Hex;
      readonly amount: string;
    }
  | {
      readonly kind: "router-swap";
      readonly tokenIn: Hex;
      readonly tokenOut: Hex;
      readonly tickSpacing: number;
      readonly recipient: Hex;
      readonly amountIn: string;
      readonly amountOutMinimum: string;
    }
  | { readonly kind: "unknown"; readonly to: Hex | null; readonly selector: string | null };

/**
 * How a located transaction was found, so a report can state which bound was hit rather
 * than implying the search was exhaustive.
 *
 * - `sender-nonce-rpc` — `eth_getTransactionBySenderAndNonce` answered. Reth/Erigon only.
 * - `count-search`     — historical `eth_getTransactionCount` probes. Needs archive state.
 * - `block-scan`       — full blocks read back from the head. Works on a pruned node.
 */
export type LocateMethod = "sender-nonce-rpc" | "count-search" | "block-scan";

export type LocatedTransaction =
  | {
      readonly found: true;
      readonly hash: Hex;
      readonly nonce: number;
      readonly blockNumber: bigint;
      readonly call: KnownCall;
      readonly method: LocateMethod;
      readonly probes: number;
    }
  | {
      /**
       * `not-consumed`    — the nonce is provably still free at the latest block.
       * `outside-lookback`— consumed before the search window; deeper history is required.
       * `unavailable`     — every probe failed. NOT evidence the nonce is free.
       * `not-in-block`    — the count moved but no matching transaction was in that block,
       *                     which means the RPC contradicted itself.
       */
      readonly found: false;
      readonly reason: "not-consumed" | "outside-lookback" | "unavailable" | "not-in-block";
      readonly probes: number;
    };

/**
 * A revert explanation. `indicative` is always true and is part of the type on purpose:
 * re-simulating at `blockNumber - 1` cannot reproduce intra-block ordering and cannot
 * reproduce out-of-gas, so this string must never be an input to an automatic action.
 */
export type RevertVerdict = {
  readonly kind:
    | "error-string"
    | "panic"
    | "custom-selector"
    | "out-of-gas"
    | "state-dependent"
    | "unknown";
  readonly detail: string;
  readonly indicative: true;
};

export type DiagnosisCode =
  /** A journaled `signed` leg now has a canonical receipt. This is the crash repair. */
  | "settled-confirmed"
  | "settled-reverted"
  /** Still in the sequencer's mempool and inside the receipt timeout. */
  | "awaiting-inclusion"
  /** No receipt, nonce still free, node holding nothing: the bytes need resending. */
  | "dropped-rebroadcast"
  /** An earlier nonce is unconsumed, so our transaction physically cannot mine. */
  | "blocked-by-nonce-gap"
  /** Our nonce was consumed by a hash that is not ours. Our bytes can never mine. */
  | "displaced-by-foreign-transaction"
  /** Nonces beyond everything this worker ever signed have been consumed. */
  | "foreign-signer-activity"
  /** A leg recorded as settled no longer re-observes to its recorded status. */
  | "receipt-changed"
  /** Every leg re-observes exactly as recorded and nothing is in flight. */
  | "journal-consistent"
  /** Chain facts were unavailable, or the journal contradicts the configured signer. */
  | "unattributable";

/**
 * What to do with a transaction that has not settled.
 *
 * `rebroadcast` means resend the identical journaled bytes. There is deliberately no
 * `replace` — see the policy note at the top of diagnosis.ts.
 */
export type StuckDecision = "none" | "wait" | "rebroadcast" | "escalate";

export type LegFacts = {
  readonly transaction: TransactionRow;
  /** `unavailable` when the observation call itself failed. Never conflated with a status. */
  readonly observed: Observation | "unavailable";
};

export type ChainFacts = {
  readonly legs: readonly LegFacts[];
  readonly nonce: NonceState | null;
  readonly journal: SignerJournal | null;
  /** Populated only when a nonce looked anomalous and was worth searching for. */
  readonly located: LocatedTransaction | null;
  /** True when a journal row was signed by something other than the strategy's own wallet. */
  readonly signerMismatch: boolean;
  readonly now: number;
};

export type Diagnosis = {
  readonly code: DiagnosisCode;
  readonly decision: StuckDecision;
  readonly leg: Leg | null;
  readonly transactionId: string | null;
  readonly hash: Hex | null;
  readonly nonce: number | null;
  readonly observed: Observation | "unavailable" | null;
  /** The one journal mutation migration 0005 permits: `signed` to its settled status. */
  readonly settle: {
    readonly transactionId: string;
    readonly status: "confirmed" | "reverted";
  } | null;
  /** True only when, after `settle` is applied, the order may leave `recovery_required`. */
  readonly clearable: boolean;
  readonly detail: string;
};

/** Log-safe scalars only. Amounts travel as strings: USDC base units exceed no bound here,
 * but a token amount at 18 decimals exceeds 2^53 and `Number()` would silently round it. */
export type RecoveryFacts = Readonly<Record<string, string | number | boolean | null>>;

export type RecoveryReport = {
  readonly executionId: string;
  readonly userId: string;
  readonly instanceId: string;
  readonly code: DiagnosisCode;
  readonly decision: StuckDecision;
  readonly settled: "confirmed" | "reverted" | null;
  readonly cleared: boolean;
  readonly rebroadcast: boolean;
  /** One sentence for an operator. Control-stripped and bounded before it is built. */
  readonly sentence: string;
  readonly facts: RecoveryFacts;
};

export type OrderWithOwner = Pick<
  ExecutionRow,
  "id" | "userId" | "instanceId" | "status" | "stage" | "reason" | "amountIn" | "createdAt"
>;
