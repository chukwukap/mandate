import { schema, type Transaction, tenant } from "@mandate/database";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { classify, jobResult, RETRY, record, rethrowFatal } from "./outcomes.js";
import type { EvaluateInstancePayload, JobDependencies, JobResult } from "./types.js";

/**
 * Order statuses that still hold the signing slot or an operator's attention. A new
 * intent must not join them: the worker executes one order at a time, and admitting a
 * second reserves budget for a trade that cannot start until the first settles.
 */
const OUTSTANDING = ["admitted", "pending", "recovery_required"] as const;

/** Evaluation outcomes that mean the state machine actually ran this tick. */
const PROGRESSED = ["evaluated", "halted", "expired"];

/**
 * Run one scheduled evaluation of an armed instance.
 *
 * IDEMPOTENCY. Two mechanisms, in order:
 *
 * 1. The due precondition below. A committed evaluation moves `nextTickAt` forward by at
 *    least the tick interval (minimum 1000 ms, and at least 30 s after a failure), so a
 *    duplicate delivery of the same payload is refused here before it spends a single RPC
 *    call.
 * 2. Admission's compare-and-set, for a duplicate that races past step 1. Admission locks
 *    the instance with SELECT ... FOR UPDATE and refuses to insert unless the status is
 *    still `armed`, `updatedAt` still equals the row the observations were gathered
 *    against, and `nextTickAt` is still due. So no evaluation row, no intent, and no
 *    budget reservation can be written twice for one tick.
 *
 * Step 2 only holds because this handler passes Admission the exact row it precondition
 * checked. Re-reading the instance after the preconditions would hand Admission a fresh
 * `updatedAt` to compare against itself and leave `nextTickAt` as the only guard.
 */
export async function evaluateInstance(
  deps: JobDependencies,
  payload: EvaluateInstancePayload,
): Promise<JobResult> {
  const { userId, instanceId } = payload;
  const base = { job: "evaluate-instance" as const, userId, instanceId };

  let loaded: Awaited<ReturnType<typeof load>>;
  try {
    loaded = await load(deps, userId, instanceId);
  } catch (error) {
    rethrowFatal(error);
    return record(deps.log, jobResult({ ...base, outcome: "failed", ...classify(error) }));
  }
  if (!loaded)
    return record(
      deps.log,
      jobResult({ ...base, outcome: "skipped", code: "instance-unavailable" }),
    );

  const { instance, draft, outstanding, evaluations } = loaded;
  const now = deps.now();
  if (instance.status !== "armed")
    return record(
      deps.log,
      jobResult({
        ...base,
        outcome: "skipped",
        code: "instance-not-armed",
        detail: { status: instance.status, haltReason: instance.haltReason },
      }),
    );
  if (instance.nextTickAt.getTime() > now.getTime())
    return record(
      deps.log,
      jobResult({
        ...base,
        outcome: "skipped",
        code: "not-due",
        retryAfterMs: instance.nextTickAt.getTime() - now.getTime(),
        detail: { nextRunAt: instance.nextTickAt.toISOString() },
      }),
    );
  if (outstanding)
    return record(
      deps.log,
      jobResult({
        ...base,
        outcome: "blocked",
        code: "order-outstanding",
        executionId: outstanding.id,
        retryAfterMs: RETRY.order,
        detail: { orderStatus: outstanding.status },
      }),
    );
  // One signer serves every owner and the worker advances one order at a time, so a new
  // automatic intent admitted now would queue behind whatever is already outstanding.
  // That is not merely slow: `chain.guard` rejects funding for an intent older than 60 s
  // ("Order intent expired before funding"), Lifecycle then writes the order `cancelled`,
  // and admission's budget reservation is never credited back. Admitting while blocked
  // therefore burns the user's period and lifetime caps on a trade that cannot happen.
  // Manual instances are exempt: a `signal` never signs anything and never queues.
  if (instance.mode === "auto") {
    let active: Awaited<ReturnType<typeof deps.store.activeExecution>>;
    try {
      // Costs one round trip per owner in the worst case, which is why it runs only for an
      // automatic instance that has already passed the cheap armed/due/per-instance checks.
      active = await deps.store.activeExecution();
    } catch (error) {
      rethrowFatal(error);
      return record(deps.log, jobResult({ ...base, outcome: "failed", ...classify(error) }));
    }
    if (active)
      return record(
        deps.log,
        jobResult({
          ...base,
          outcome: "blocked",
          code: "signer-busy",
          executionId: active.id,
          retryAfterMs: RETRY.order,
          detail: { blockingStatus: active.status, blockingOwned: active.userId === userId },
        }),
      );
  }

  try {
    // The row read above is the compare-and-set token; see the note on this function.
    // Admission never throws for an unavailable observation — it records the failure as
    // the evaluation outcome — so anything that escapes here is a database, leadership or
    // catalogue fault, and left the instance untouched.
    await deps.admission.run(instance, draft);
  } catch (error) {
    rethrowFatal(error);
    return record(deps.log, jobResult({ ...base, outcome: "failed", ...classify(error) }));
  }

  let after: Awaited<ReturnType<typeof reread>>;
  try {
    after = await reread(deps, userId, instanceId);
  } catch (error) {
    rethrowFatal(error);
    // The evaluation itself already committed; only the report is missing.
    return record(deps.log, jobResult({ ...base, outcome: "failed", ...classify(error) }));
  }
  if (!after.instance)
    return record(
      deps.log,
      jobResult({ ...base, outcome: "skipped", code: "instance-unavailable" }),
    );

  const retryAfterMs = Math.max(0, after.instance.nextTickAt.getTime() - deps.now().getTime());
  // A new evaluation row is the only reliable proof that this tick committed. The
  // instance's `updatedAt` cannot be used: Lifecycle also writes it when it halts an
  // instance for recovery, so it moves for reasons that are not an evaluation at all.
  // Counting rather than comparing the newest id keeps the decision independent of how
  // two rows with an identical `at` would sort.
  if (after.evaluations <= evaluations || !after.evaluation)
    return record(
      deps.log,
      jobResult({
        ...base,
        outcome: "skipped",
        code: "evaluation-not-committed",
        retryAfterMs,
        detail: {
          status: after.instance.status,
          nextRunAt: after.instance.nextTickAt.toISOString(),
        },
      }),
    );

  const outcome = after.evaluation.outcome;
  return record(
    deps.log,
    jobResult({
      ...base,
      outcome: PROGRESSED.includes(outcome) ? "applied" : "blocked",
      code: outcome,
      retryAfterMs,
      detail: {
        admitted: after.evaluation.admitted,
        // `refused` and `haltReason` are sentences this codebase authors in the strategy
        // engine; no upstream error text reaches either column.
        refused: after.evaluation.refused,
        status: after.instance.status,
        haltReason: after.instance.haltReason,
        nextRunAt: after.instance.nextTickAt.toISOString(),
        lastRunAt: after.instance.lastTickAt?.toISOString() ?? null,
      },
    }),
  );
}

/**
 * One tenant transaction for every precondition input. These reads happen BEFORE the
 * observations Admission gathers, never between them and its commit: Admission discards a
 * snapshot older than 30 s, and each extra round trip inside that window is 30 s of budget
 * spent on nothing.
 */
async function load(deps: JobDependencies, userId: string, instanceId: string) {
  return tenant(deps.store.db, userId, async (tx) => {
    const [row] = await tx
      .select({ instance: schema.instances, draft: schema.drafts })
      .from(schema.instances)
      .innerJoin(schema.drafts, eq(schema.drafts.id, schema.instances.draftId))
      .where(eq(schema.instances.id, instanceId))
      .limit(1);
    if (!row) return undefined;
    const [outstanding] = await tx
      .select({ id: schema.executions.id, status: schema.executions.status })
      .from(schema.executions)
      .where(
        and(
          eq(schema.executions.instanceId, instanceId),
          inArray(schema.executions.status, [...OUTSTANDING]),
        ),
      )
      .orderBy(asc(schema.executions.createdAt), asc(schema.executions.id))
      .limit(1);
    return { ...row, outstanding, evaluations: await total(tx, instanceId) };
  });
}

async function reread(deps: JobDependencies, userId: string, instanceId: string) {
  return tenant(deps.store.db, userId, async (tx) => {
    const [instance] = await tx
      .select()
      .from(schema.instances)
      .where(eq(schema.instances.id, instanceId))
      .limit(1);
    // Spacing between two evaluations is at least one tick interval (1000 ms floor), so
    // the newest row by `at` is unambiguous and is the one this tick wrote.
    const [evaluation] = await tx
      .select()
      .from(schema.evaluations)
      .where(eq(schema.evaluations.instanceId, instanceId))
      .orderBy(desc(schema.evaluations.at), desc(schema.evaluations.id))
      .limit(1);
    return { instance, evaluation, evaluations: await total(tx, instanceId) };
  });
}

async function total(tx: Transaction, instanceId: string) {
  const [row] = await tx
    .select({ value: count() })
    .from(schema.evaluations)
    .where(eq(schema.evaluations.instanceId, instanceId));
  return row?.value ?? 0;
}
