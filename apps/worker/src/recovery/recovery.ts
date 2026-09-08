import type { Hex } from "@mandate/contracts";
import type { ExecutionRow, TransactionRow } from "@mandate/database";
import { type Database, schema, type WorkerStore } from "@mandate/database";
import { and, eq } from "drizzle-orm";
import { DEFAULT_REBROADCAST_AFTER_MS, diagnose, type StuckPolicy } from "./diagnosis.js";
import { eachOwner } from "./owners.js";
import { SignerHistory } from "./signer.js";
import type {
  ChainFacts,
  LegFacts,
  RecoveryChain,
  RecoveryLogger,
  SignerJournal,
} from "./types.js";

/**
 * The orchestrator these pure functions were written for.
 *
 * `diagnosis.ts`, `signer.ts` and `owners.ts` were complete and fully tested, and nothing
 * constructed any of them: the whole directory was unreachable from `main.ts`. The consequence
 * was specific and bad. `Worker.cycle` blocks admissions for EVERY owner while any execution is
 * outstanding, `Lifecycle.run` returns immediately on `recovery_required`, and no code path
 * moved an order out of that state — so one stuck order halted the entire fleet permanently,
 * and the only way out was editing the database by hand.
 *
 * This class is deliberately thin. It gathers facts, hands them to `diagnose`, and carries out
 * the one decision that comes back. Every judgement stays in the pure functions where it can be
 * tested without a chain.
 *
 * # What it will never do
 *
 * Rebroadcast means resending the IDENTICAL journaled bytes. There is no fee bump and no
 * replacement transaction, because replacing means signing something the journal does not
 * contain, and the journal is the only record of what this worker authorised. A transaction
 * that cannot be resent into existence is escalated to a human instead.
 */

/** How many owners a single recovery pass will page through when reading signer history. */
const MAX_OWNERS = 5_000;

export interface RecoveryDeps {
  store: WorkerStore;
  db: Database;
  chain: RecoveryChain;
  log: RecoveryLogger;
  /** The configured spender. A journal signed by anything else is unattributable. */
  spender: Hex;
  receiptTimeoutMs: number;
  rebroadcastAfterMs?: number;
  now?: () => number;
}

export class Recovery {
  private readonly history: SignerHistory;
  private readonly policy: StuckPolicy;
  private readonly now: () => number;

  constructor(private readonly deps: RecoveryDeps) {
    this.history = new SignerHistory(deps.chain.client);
    this.policy = {
      receiptTimeoutMs: deps.receiptTimeoutMs,
      rebroadcastAfterMs: deps.rebroadcastAfterMs ?? DEFAULT_REBROADCAST_AFTER_MS,
    };
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Examine one stuck order and act on the diagnosis.
   *
   * Never throws. A recovery pass that fails is a pass that changes nothing, and the order stays
   * exactly where it was — which is the correct outcome, because the alternative is a partial
   * recovery whose own failure is indistinguishable from the fault it was trying to fix.
   */
  async run(order: ExecutionRow): Promise<void> {
    try {
      const facts = await this.gather(order);
      const verdict = diagnose(order, facts, this.policy);
      const line = {
        execution: order.id,
        instance: order.instanceId,
        code: verdict.code,
        decision: verdict.decision,
        leg: verdict.leg,
        nonce: verdict.nonce,
        observed: verdict.observed,
      };

      switch (verdict.decision) {
        case "wait":
          this.deps.log.debug(line, `Recovery waiting: ${verdict.detail}`);
          return;

        case "rebroadcast": {
          const bytes = facts.legs.find(
            (leg) => leg.transaction.id === verdict.transactionId,
          )?.transaction;
          if (!bytes) {
            this.deps.log.error(line, "Recovery wanted to rebroadcast a leg it cannot find");
            return;
          }
          // The same bytes, unchanged. `broadcast` re-checks that the signer and the hash still
          // match the journal before it sends, so a tampered row cannot be resent.
          await this.deps.chain.broadcast(bytes);
          this.deps.log.warn(line, `Rebroadcast journaled bytes: ${verdict.detail}`);
          return;
        }

        case "escalate":
          // Loud, and nothing else. Escalation exists precisely for the cases where an automated
          // action would be a guess, and a guess about money is worse than a stopped queue.
          this.deps.log.error(line, `Recovery needs an operator: ${verdict.detail}`);
          return;

        case "none": {
          if (verdict.settle) await this.settle(order, verdict.settle);
          if (verdict.clearable) {
            await this.clear(order, verdict.detail);
            this.deps.log.info(line, `Recovery cleared the order: ${verdict.detail}`);
            return;
          }
          this.deps.log.info(line, `Recovery reconciled without clearing: ${verdict.detail}`);
          return;
        }
      }
    } catch (error) {
      this.deps.log.error(
        {
          execution: order.id,
          reason: error instanceof Error ? error.message : String(error),
        },
        "Recovery pass failed; the order is unchanged",
      );
    }
  }

  /** Everything `diagnose` needs, and nothing it does not. */
  private async gather(order: ExecutionRow): Promise<ChainFacts> {
    const journal = await this.deps.store.journal(order.userId, order.id);
    const legs: LegFacts[] = [];
    for (const transaction of journal) {
      // `unavailable` rather than a guess. An observation that could not be made is a different
      // fact from a transaction that is pending, and conflating them is how a dropped
      // transaction gets treated as one still in flight.
      const observed = await this.deps.chain
        .observe(transaction)
        .catch(() => "unavailable" as const);
      legs.push({ transaction, observed });
    }

    const spender = this.deps.spender.toLowerCase();
    const signerMismatch = journal.some((row) => row.signer.toLowerCase() !== spender);

    return {
      legs,
      nonce: await this.history.nonceState(this.deps.spender).catch(() => null),
      journal: signerMismatch ? null : await this.signerJournal(),
      located: null,
      signerMismatch,
      now: this.now(),
    };
  }

  /**
   * Every nonce this worker has ever committed for the spender key, across all owners.
   *
   * Read through `eachOwner` rather than `WorkerStore.owners()`: that method advances a cursor
   * held on the shared store that the scheduling loop also reads, so borrowing it here would
   * silently skip a page of owners for that loop and the strategies on it would stop ticking
   * with nothing in the logs.
   *
   * `complete` is what makes the answer usable. `foreignActivity` treats an incomplete read as
   * "cannot tell" rather than as evidence, so a truncated scan can never accuse the key of
   * being used by somebody else.
   */
  private async signerJournal(): Promise<SignerJournal> {
    const spender = this.deps.spender.toLowerCase();
    let ceiling = 0;
    const unsettled: number[] = [];

    const walk = await eachOwner(this.deps.db, MAX_OWNERS, async (_userId, tx) => {
      const rows = await tx
        .select({
          nonce: schema.transactions.nonce,
          status: schema.transactions.status,
        })
        .from(schema.transactions)
        .where(eq(schema.transactions.signer, spender));
      for (const row of rows) {
        ceiling = Math.max(ceiling, row.nonce + 1);
        if (row.status === "signed") unsettled.push(row.nonce);
      }
    });

    return { ceiling, unsettled, complete: walk.complete };
  }

  /**
   * The one journal mutation the schema permits: a `signed` row becoming settled.
   *
   * Migration 0005 makes `transactions` append-only apart from exactly this transition, so a
   * recovery pass can record what the chain says happened and cannot rewrite anything else.
   */
  private async settle(
    order: ExecutionRow,
    settle: { transactionId: string; status: "confirmed" | "reverted" },
  ): Promise<void> {
    await this.deps.store.write(order.userId, async (tx) => {
      await tx
        .update(schema.transactions)
        .set({ status: settle.status })
        .where(
          and(
            eq(schema.transactions.id, settle.transactionId),
            // Guarded on the current status as well as the id: if another pass settled it in
            // between, this write must be a no-op rather than a second verdict.
            eq(schema.transactions.status, "signed"),
          ),
        );
    });
  }

  /**
   * Return the order to the lifecycle, and the instance to the user.
   *
   * `recovery_required` halts the instance as well as the order, so clearing one without the
   * other would leave a user whose strategy is permanently halted for a fault that has been
   * resolved. Back to `paused`, not `armed`: the fault interrupted something, and re-arming is
   * the owner's decision to make.
   */
  private async clear(order: ExecutionRow, detail: string): Promise<void> {
    await this.deps.store.write(order.userId, async (tx) => {
      await tx
        .update(schema.executions)
        .set({ status: "pending", reason: detail, updatedAt: new Date() })
        .where(eq(schema.executions.id, order.id));
      await tx
        .update(schema.instances)
        .set({ status: "paused", haltReason: null, updatedAt: new Date() })
        .where(eq(schema.instances.id, order.instanceId));
    });
  }
}

export type { RecoveryChain, RecoveryLogger } from "./types.js";
