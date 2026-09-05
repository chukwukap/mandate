import type { Hex } from "@mandate/contracts";
import { CHAIN_ID } from "@mandate/evm";
import type { Leg } from "../lifecycle.js";
import { checkGas, describeGasShortfall } from "./gas.js";
import { planNonce } from "./nonce.js";
import { simulate } from "./simulation.js";
import type {
  JournalEntry,
  RecordedSubmission,
  SubmissionCall,
  SubmissionChain,
  SubmissionJournal,
  SubmissionRefusalCode,
  SubmissionResult,
} from "./types.js";

/**
 * Build, simulate, sign, record, simulate again, broadcast.
 *
 * The ordering is the entire contents of this file, and two constraints fix it:
 *
 *  A. SIGNED BYTES MUST BE DURABLE BEFORE THEY CAN REACH A NODE. A transaction that is
 *     broadcast and then lost — because the process died between `send` and the database
 *     write — is a transaction that mines with nobody watching. For a `fund` leg that means
 *     a user's USDC arrives in a server wallet with no journal row saying so, no receipt to
 *     reconcile, and no order to return it against. So `record` happens first, and the
 *     opposite ordering is not a performance trade-off, it is a lost-funds bug.
 *
 *  B. A TRANSACTION IS SIMULATED IMMEDIATELY BEFORE IT IS SENT. Simulating before signing
 *     is not enough. The gap between the two is at least one database commit and, in this
 *     worker's actual shape, at least one poll interval — and the things that change in
 *     that gap are precisely the things that make a swap fail: the quote deadline expires,
 *     the pool moves past `amountOutMinimum`, the permission's period rolls, the user
 *     revokes. Sending anyway costs gas to be told what an `eth_call` would have said for
 *     free.
 *
 * The two constraints interact, and the interaction is uncomfortable rather than elegant.
 * If the pre-broadcast simulation reverts, the bytes are already journaled and their nonce
 * is already taken, and `mandate_v2.transactions` has no "abandoned" status to move them
 * to. That is reported as `stale-submission` and it is a genuine operator condition: the
 * spender key is blocked until someone resolves the row. Making it silent — by broadcasting
 * anyway, or by skipping the second simulation — would trade a visible stall for a paid
 * revert or a lost transaction, and both are worse.
 *
 * Everything that decides is a pure function elsewhere in this directory. This class only
 * sequences them, so the sequencing can be read in one screen.
 */

export type SubmissionRequest = {
  readonly executionId: string;
  readonly userId: string;
  readonly leg: Leg;
  readonly signer: Hex;
  readonly call: SubmissionCall;
};

export type SubmitterOptions = {
  /** Base. Overridable only so tests can pin a fixture chain. */
  readonly chainId?: number | undefined;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_DATA = /^0x([0-9a-fA-F]{2})*$/;

function refuse(code: SubmissionRefusalCode, detail: string): SubmissionResult {
  return { status: "refused", refusal: { code, detail } };
}

/**
 * A row read back out of the journal is durable by construction — it came from a committed
 * transaction — so it carries the marker that lets it be broadcast. The marker exists to
 * make constraint (A) a type error rather than a code review comment: `dispatch` accepts
 * only `RecordedSubmission`, and the only two ways to obtain one are `journal.record` and
 * this function, which is not exported.
 */
function recorded(entry: JournalEntry): RecordedSubmission {
  return { ...entry, recorded: true };
}

/**
 * Was a rejected `eth_sendRawTransaction` actually a rejection?
 *
 * Three of the standard refusals mean the node already has what we were trying to give it,
 * and treating those as failures is how a resend loop turns a settled transaction into a
 * recovery incident:
 *
 *  - "already known" / "known transaction": identical bytes are in the mempool. This is the
 *    expected answer on every resend and is a success.
 *  - "nonce too low": the nonce is consumed. Usually by our own transaction, which has
 *    mined. It CAN be a foreign transaction that displaced us — but nothing at this layer
 *    can tell the two apart, and the receipt read that follows can. Reporting `broadcast`
 *    hands the question to reconciliation, which is where it is answerable.
 *  - "replacement transaction underpriced": something else is sitting at our nonce. That is
 *    a conflict, not a success, because our bytes cannot enter the pool at all.
 *
 * The error's message is matched but never copied out: a viem send error embeds the raw
 * signed transaction, and a message that has passed through no redaction must not become a
 * log line or an `executions.reason`.
 */
function classifySendFailure(error: unknown): "accepted" | "conflict" | "retry" {
  let message = "";
  let node: unknown = error;
  const seen = new Set<unknown>();
  while (node !== null && typeof node === "object" && !seen.has(node) && message.length < 8000) {
    seen.add(node);
    const own = (node as { message?: unknown }).message;
    if (typeof own === "string") message += ` ${own}`;
    node = (node as { cause?: unknown }).cause;
  }
  if (/replacement transaction underpriced|already imported/i.test(message)) return "conflict";
  if (/already known|known transaction|nonce too low|already exists/i.test(message))
    return "accepted";
  return "retry";
}

export class Submitter {
  private readonly chainId: number;

  constructor(
    private readonly chain: SubmissionChain,
    private readonly journal: SubmissionJournal,
    options: SubmitterOptions = {},
  ) {
    this.chainId = options.chainId ?? CHAIN_ID;
  }

  /**
   * Everything up to and including the durable write. Nothing is sent.
   *
   * Returns `prepared` both when new bytes were signed and when the journal already held
   * unsettled bytes for this order and leg. Those two cases are indistinguishable to a
   * caller on purpose: after a crash between `record` and `send`, the correct action is the
   * same one as after a successful prepare — dispatch what is in the journal.
   */
  async prepare(request: SubmissionRequest): Promise<SubmissionResult> {
    const { signer, call } = request;
    if (!ADDRESS.test(signer))
      return refuse("nonce-conflict", "The configured spender is not an address.");
    if (!ADDRESS.test(call.to) || !HEX_DATA.test(call.data))
      return refuse("would-revert", "The prepared call is not a well-formed transaction.");

    const network = await this.network();
    if (network) return network;

    let counts: { latest: number; pending: number };
    let entries: readonly JournalEntry[];
    try {
      // Sequential, not parallel. The journal read is the cheap local one and the counts
      // are the volatile remote one; reading the chain last narrows the window in which the
      // two views of the same key can disagree.
      entries = await this.journal.entries(signer);
      counts = await this.chain.transactionCounts(signer);
    } catch {
      return refuse(
        "chain-unavailable",
        "The spender key's nonce state could not be read; nothing was signed.",
      );
    }

    const plan = planNonce({
      signer,
      latest: counts.latest,
      pending: counts.pending,
      entries,
      executionId: request.executionId,
      leg: request.leg,
    });
    if (plan.kind === "blocked") return refuse("nonce-conflict", plan.detail);
    if (plan.kind === "resend") return { status: "prepared", entry: recorded(plan.entry) };

    // Gas before simulation: an order that cannot afford its own unwind must not be started
    // even if it would simulate perfectly.
    let balance: bigint;
    let maxFeePerGas: bigint;
    try {
      balance = await this.chain.balance(signer);
      maxFeePerGas = await this.chain.maxFeePerGas();
    } catch {
      return refuse("chain-unavailable", "The spender key's gas balance could not be read.");
    }
    const budget = checkGas({ leg: request.leg, balance, maxFeePerGas });
    if (!budget.sufficient) return refuse("insufficient-gas", describeGasShortfall(budget));

    const verdict = await simulate(() => this.chain.simulate({ signer, call }));
    if (verdict.kind === "reverted")
      return refuse(
        "would-revert",
        `The ${request.leg} transaction would revert: ${verdict.detail}`,
      );
    if (verdict.kind === "unavailable") return refuse("simulation-unavailable", verdict.detail);

    let signed: Awaited<ReturnType<SubmissionChain["sign"]>>;
    try {
      signed = await this.chain.sign({ signer, call, nonce: plan.nonce });
    } catch {
      // Local signing has no legitimate transient failure: the key is wrong, the request is
      // malformed, or the signer is misconfigured. Retrying repeats the same failure, so
      // this is terminal and an operator sees it rather than a hot loop.
      return refuse("sign-failed", "The transaction could not be signed.");
    }
    if (signed.nonce !== plan.nonce || signed.signer.toLowerCase() !== signer.toLowerCase())
      // The signer returned something other than what was asked for. Every guarantee in
      // `nonce.ts` is stated about the nonce this pipeline chose, so bytes carrying a
      // different one are outside all of them and are discarded unrecorded and unsent.
      return refuse(
        "nonce-conflict",
        `Signing produced nonce ${signed.nonce} for ${signed.signer.toLowerCase()}; ${plan.nonce} was requested for ${signer.toLowerCase()}.`,
      );

    try {
      const entry = await this.journal.record({
        executionId: request.executionId,
        userId: request.userId,
        leg: request.leg,
        signed,
      });
      return { status: "prepared", entry };
    } catch {
      // The unique constraints did their job, or the database is down. Either way the bytes
      // exist only in this stack frame and are about to be discarded, which is the entire
      // reason the write comes before the send.
      return refuse(
        "not-recorded",
        "The signed transaction could not be journaled, so it was not broadcast.",
      );
    }
  }

  /**
   * Re-simulate and broadcast bytes that are already durable.
   *
   * `call` is optional because it may not be reconstructible: after a restart the journal
   * has the signed bytes but not the call they encode. Passing it enables constraint (B);
   * omitting it broadcasts on the strength of the simulation that ran before signing. That
   * is a real weakening and it is the right default anyway — refusing to resend a
   * transaction that may already be in a mempool is strictly worse than sending it twice,
   * because identical bytes are one transaction and an abandoned one is an incident.
   */
  async dispatch(entry: RecordedSubmission, call?: SubmissionCall): Promise<SubmissionResult> {
    const network = await this.network();
    if (network) return network;

    if (call) {
      const verdict = await simulate(() =>
        this.chain.simulate({ signer: entry.signer as Hex, call }),
      );
      if (verdict.kind === "reverted")
        return refuse(
          "stale-submission",
          `Journaled ${entry.leg} bytes now revert (${verdict.detail}); they were not broadcast and the spender key is blocked at nonce ${entry.nonce} until this row is resolved.`,
        );
      if (verdict.kind === "unavailable")
        // The bytes stay journaled and valid. Waiting costs nothing; sending blind might.
        return refuse("simulation-unavailable", verdict.detail);
    }

    try {
      await this.chain.send(entry.rawTransaction as Hex);
      return { status: "broadcast", entry };
    } catch (error) {
      const outcome = classifySendFailure(error);
      if (outcome === "accepted") return { status: "broadcast", entry };
      if (outcome === "conflict")
        return refuse(
          "nonce-conflict",
          `The node refused nonce ${entry.nonce} for the spender key because a different transaction already occupies it.`,
        );
      return refuse(
        "chain-unavailable",
        "The transaction could not be broadcast; it stays journaled.",
      );
    }
  }

  /**
   * Prepare and dispatch in one call.
   *
   * Correct only for a caller that owns the whole sequence in one process. The worker's
   * lifecycle deliberately splits the two across polls so that a crash between them is
   * survivable by construction, and that split is what makes the second simulation a real
   * check rather than a repeat of the first one microseconds later.
   */
  async submit(request: SubmissionRequest): Promise<SubmissionResult> {
    const prepared = await this.prepare(request);
    if (prepared.status !== "prepared") return prepared;
    return this.dispatch(prepared.entry, request.call);
  }

  /**
   * Refuse to act unless the RPC is serving the chain we think it is.
   *
   * Checked on every prepare AND every dispatch, not once at startup. A provider that fails
   * over, a URL edited in a restart, or a fork used for testing all report a different
   * chain's nonces for the same key — and a nonce chosen from the wrong chain either
   * collides with a mainnet transaction or leaves a gap that parks the real one.
   */
  private async network(): Promise<SubmissionResult | null> {
    let id: number;
    try {
      id = await this.chain.chainId();
    } catch {
      return refuse("chain-unavailable", "The chain could not be identified.");
    }
    return id === this.chainId
      ? null
      : refuse("wrong-network", `The RPC is serving chain ${id}, not ${this.chainId}.`);
  }
}
