import type { DraftRow, ExecutionRow, InstanceRow, WorkerStore } from "@mandate/database";
import { z } from "zod";

/**
 * The job contract the scheduler dispatches against. Payloads carry identifiers only:
 * a queue entry can outlive the row it names, so every handler re-reads durable state
 * and never trusts a copy that travelled through the queue.
 */
export const jobNames = ["evaluate-instance", "execute-intent"] as const;
export type JobName = (typeof jobNames)[number];

export const evaluateInstancePayloadSchema = z.object({
  userId: z.uuid(),
  instanceId: z.uuid(),
});
export type EvaluateInstancePayload = z.infer<typeof evaluateInstancePayloadSchema>;

export const executeIntentPayloadSchema = z.object({
  userId: z.uuid(),
  executionId: z.uuid(),
});
export type ExecuteIntentPayload = z.infer<typeof executeIntentPayloadSchema>;

export const jobSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("evaluate-instance"), payload: evaluateInstancePayloadSchema }),
  z.object({ name: z.literal("execute-intent"), payload: executeIntentPayloadSchema }),
]);
export type Job = z.infer<typeof jobSchema>;

/**
 * `applied`  durable state changed: an evaluation was recorded, or an order leg advanced.
 * `skipped`  a precondition said there is nothing to do; re-dispatching changes nothing.
 * `blocked`  real work is waiting on something external — a chain receipt, another order,
 *            an operator, or a disabled execution flag. Honour `retryAfterMs`.
 * `failed`   an error stopped the job. Durable state is consistent and the job is safe to
 *            retry; the idempotency mechanisms below make a retry harmless.
 */
export type JobOutcome = "applied" | "skipped" | "blocked" | "failed";

/**
 * Log-safe scalars only. Token amounts travel as the decimal/integer STRINGS the database
 * holds: an 18-decimal amount exceeds 2^53, so putting one through `Number()` for a log
 * line silently rounds it. No field here ever carries a signature or signed bytes.
 */
export type JobDetail = Readonly<Record<string, string | number | boolean | null>>;

export type JobResult = {
  readonly job: JobName;
  readonly outcome: JobOutcome;
  /** Stable machine-readable reason. Never interpolated from an upstream error message. */
  readonly code: string;
  readonly userId: string;
  readonly instanceId: string | null;
  readonly executionId: string | null;
  /** Scheduler hint in milliseconds; `null` means nothing is known to change on a timer. */
  readonly retryAfterMs: number | null;
  readonly detail: JobDetail;
};

/** Structurally satisfied by a pino logger, so `main.ts` can pass its own logger unwrapped. */
export interface JobLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Admission commits the evaluation; it reports nothing, so handlers read state back. */
export interface AdmissionRunner {
  run(instance: InstanceRow, draft: DraftRow): Promise<void>;
}
/** Lifecycle advances at most ONE leg per call and is the only writer of order status. */
export interface LifecycleRunner {
  run(order: ExecutionRow): Promise<void>;
}

export type JobDependencies = {
  readonly store: WorkerStore;
  readonly admission: AdmissionRunner;
  readonly lifecycle: LifecycleRunner;
  /**
   * WORKER_EXECUTE. Handlers refuse `execute-intent` outright when this is false rather
   * than letting Lifecycle discover it: with execution off, `chain.prepare` throws
   * "Live execution disabled", which Lifecycle turns into a permanent `cancelled` order.
   * Budget reservations are never credited back, so a config flag would burn a user's
   * period and lifetime caps for a trade that never happened.
   */
  readonly executeEnabled: boolean;
  readonly log: JobLogger;
  /**
   * Injected for deterministic tests. It must track the same wall clock Admission and
   * Lifecycle use internally (`new Date()`); a skewed clock only mis-times the due check
   * and the retry hints — it can never let a stale evaluation commit, because the
   * authoritative due comparison happens inside Admission's locked transaction.
   */
  readonly now: () => Date;
};
