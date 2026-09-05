import { Problem } from "@mandate/contracts";
import {
  type ExecutionRow,
  type Repository,
  schema,
  type TransactionRow,
  tenant,
} from "@mandate/database";
import { USDC } from "@mandate/evm";
import type { Envelope, Runtime } from "@mandate/strategy";
import { and, asc, count, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";

const { drafts, evaluations, executions, instances, transactions } = schema;

export type ExecutionRecord = {
  execution: ExecutionRow;
  strategyName: string;
  envelope: Envelope;
};

export type ExecutionDetailRecord = ExecutionRecord & {
  account: string;
  journal: TransactionRow[];
  /** The evaluation that admitted this order, when it can be paired. */
  evaluation: typeof evaluations.$inferSelect | undefined;
};

export type ListQuery = {
  instance?: string | undefined;
  statuses?: readonly string[] | undefined;
  limit: number;
  before?: Date | undefined;
  beforeId?: string | undefined;
};

export type StatusTotal = {
  status: string;
  orders: number;
  /** Raw USDC integer of `amount_in` across orders in this status whose input was USDC. */
  usdcIn: bigint;
};

export type RefusalTotal = { outcome: string; refused: string | null; ticks: number };

export type SummaryRecord = {
  instanceName: string;
  instanceStatus: string;
  instanceMode: string;
  runtime: Runtime;
  envelope: Envelope;
  totals: StatusTotal[];
  first: Date | null;
  last: Date | null;
  evaluations: { ticks: number; admitted: number; refusals: RefusalTotal[]; truncated: boolean };
};

/** Cap on distinct (outcome, refused) groups returned. The vocabulary is far smaller. */
const REFUSAL_GROUP_LIMIT = 100;

/**
 * Reads of a user's own execution history.
 *
 * Every statement runs inside `tenant()`. The tables are FORCE ROW LEVEL SECURITY, so a bare
 * `db.select()` returns nothing under the application role — and would return *other users'
 * rows* under a role that bypasses RLS. The `user_id` predicates below are therefore belt and
 * braces on top of the policy, not the only guard, and both are deliberate.
 */
export class ExecutionQueries {
  constructor(private readonly repo: Repository) {}

  /**
   * Keyset page across every instance the user owns.
   *
   * Ordered by `(created_at, id)` descending, never `created_at` alone: one tick can admit
   * several orders inside a single transaction with an identical millisecond timestamp, and a
   * timestamp-only cursor silently drops the rest of that group at the page boundary. This
   * mirrors `Repository.list`.
   *
   * The drafts join selects only `envelope`. Selecting the whole draft row would drag `plan`,
   * `render_text` and `confirm_message` — kilobytes each — through the wire for every row, to
   * read four asset decimals.
   */
  async list(user: string, query: ListQuery): Promise<ExecutionRecord[]> {
    const rows = await tenant(this.repo.db, user, (tx) =>
      tx
        .select({
          execution: executions,
          strategyName: instances.name,
          envelope: drafts.envelope,
        })
        .from(executions)
        .innerJoin(
          instances,
          and(eq(instances.id, executions.instanceId), eq(instances.userId, user)),
        )
        .innerJoin(drafts, and(eq(drafts.id, instances.draftId), eq(drafts.userId, user)))
        .where(
          and(
            eq(executions.userId, user),
            query.instance ? eq(executions.instanceId, query.instance) : undefined,
            query.statuses?.length ? inArray(executions.status, [...query.statuses]) : undefined,
            query.before
              ? or(
                  lt(executions.createdAt, query.before),
                  query.beforeId
                    ? and(eq(executions.createdAt, query.before), lt(executions.id, query.beforeId))
                    : undefined,
                )
              : undefined,
          ),
        )
        .orderBy(desc(executions.createdAt), desc(executions.id))
        .limit(query.limit),
    );
    return rows;
  }

  /**
   * One execution with everything durable that is known about it.
   *
   * All four reads share one transaction so the journal cannot gain a leg between the
   * execution read and the journal read, which would render a stage the row does not claim.
   */
  async detail(user: string, id: string): Promise<ExecutionDetailRecord> {
    return tenant(this.repo.db, user, async (tx) => {
      const [row] = await tx
        .select({
          execution: executions,
          strategyName: instances.name,
          envelope: drafts.envelope,
          account: drafts.account,
        })
        .from(executions)
        .innerJoin(
          instances,
          and(eq(instances.id, executions.instanceId), eq(instances.userId, user)),
        )
        .innerJoin(drafts, and(eq(drafts.id, instances.draftId), eq(drafts.userId, user)))
        .where(and(eq(executions.id, id), eq(executions.userId, user)));
      // A foreign or unknown id is 404, never an empty detail. "This never happened" and
      // "this is not yours" must look identical from outside.
      if (!row) throw Problem.notFound();
      const journal = await tx
        .select()
        .from(transactions)
        .where(and(eq(transactions.executionId, id), eq(transactions.userId, user)))
        .orderBy(asc(transactions.createdAt), asc(transactions.nonce));
      // Admission.run inserts the evaluation and every execution it admits with the same
      // `now` inside one transaction, so an exact timestamp match is the pairing. It is an
      // equality and not a window on purpose: attributing a merely nearby tick's prices to
      // this fill would put numbers on the page that no rule ever saw.
      const [evaluation] = await tx
        .select()
        .from(evaluations)
        .where(
          and(
            eq(evaluations.instanceId, row.execution.instanceId),
            eq(evaluations.userId, user),
            eq(evaluations.at, row.execution.createdAt),
          ),
        )
        .limit(1);
      return { ...row, journal, evaluation };
    });
  }

  /**
   * Per-instance rollup.
   *
   * Ownership is asserted through `Repository.detail`, which throws 404 for an instance that
   * is not the caller's. Without it a foreign id would produce a summary of zeroes, which
   * reads as "your strategy never did anything" rather than "that is not your strategy".
   */
  async summary(user: string, instance: string, since: Date): Promise<SummaryRecord> {
    const { instance: row, draft } = await this.repo.detail(user, instance);
    const quote = USDC.toLowerCase();
    return tenant(this.repo.db, user, async (tx) => {
      const totals = await tx
        .select({
          status: executions.status,
          orders: count(),
          // amount_in is text with a `^[0-9]+$` CHECK, so the numeric cast cannot fail. Only
          // USDC inputs are summed: a sell's amount_in is denominated in the asset's own 8
          // decimals, and adding those integers to 6-decimal USDC integers would be nonsense.
          usdcIn: sql<string>`coalesce(sum(case when lower(${executions.tokenIn}) = ${quote} then cast(${executions.amountIn} as numeric) else 0 end), 0)::text`,
        })
        .from(executions)
        .where(and(eq(executions.instanceId, instance), eq(executions.userId, user)))
        .groupBy(executions.status);
      // First and last are read as columns rather than as min()/max() so drizzle's own
      // timestamp mapping produces Date objects. A raw aggregate bypasses that mapping and
      // comes back as a driver-shaped string, which differs between node-postgres and PGlite.
      const bounds = async (direction: typeof asc) => {
        const [edge] = await tx
          .select({ at: executions.createdAt })
          .from(executions)
          .where(and(eq(executions.instanceId, instance), eq(executions.userId, user)))
          .orderBy(direction(executions.createdAt))
          .limit(1);
        return edge?.at ?? null;
      };
      // Sequential on purpose: these share the transaction's single connection, and pooling a
      // Promise.all onto one client only queues them anyway.
      const first = await bounds(asc);
      const last = await bounds(desc);
      const [ticks] = await tx
        .select({
          ticks: count(),
          admitted: sql<string>`coalesce(sum(${evaluations.admitted}), 0)::text`,
        })
        .from(evaluations)
        .where(
          and(
            eq(evaluations.instanceId, instance),
            eq(evaluations.userId, user),
            gte(evaluations.at, since),
          ),
        );
      // Evaluation volume is unbounded — a 12s tick over 30 days is roughly 216,000 rows — so
      // the refusal ledger is computed over a declared recent window rather than presented as
      // lifetime truth. The window keeps this on the (instance_id, at) index and inside the
      // pool's 10s statement_timeout.
      const refusals = await tx
        .select({
          outcome: evaluations.outcome,
          refused: evaluations.refused,
          ticks: count(),
        })
        .from(evaluations)
        .where(
          and(
            eq(evaluations.instanceId, instance),
            eq(evaluations.userId, user),
            gte(evaluations.at, since),
          ),
        )
        .groupBy(evaluations.outcome, evaluations.refused)
        .orderBy(desc(count()))
        .limit(REFUSAL_GROUP_LIMIT + 1);
      const kept = refusals.slice(0, REFUSAL_GROUP_LIMIT);
      return {
        instanceName: row.name,
        instanceStatus: row.status,
        instanceMode: row.mode,
        runtime: row.runtime,
        envelope: draft.envelope,
        totals: totals.map((t) => ({
          status: t.status,
          orders: t.orders,
          usdcIn: BigInt(t.usdcIn),
        })),
        first,
        last,
        evaluations: {
          // Counted over the whole window, not summed from `kept`: a truncated group list must
          // not make the tick count look smaller than it was.
          ticks: ticks?.ticks ?? 0,
          admitted: Number(ticks?.admitted ?? "0"),
          refusals: kept.map((r) => ({ outcome: r.outcome, refused: r.refused, ticks: r.ticks })),
          truncated: refusals.length > REFUSAL_GROUP_LIMIT,
        },
      };
    });
  }
}
