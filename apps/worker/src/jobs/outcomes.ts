import { createHash } from "node:crypto";
import { Problem } from "@mandate/contracts";
import { LeadershipLost } from "@mandate/database";
import { RecoveryRequired } from "@mandate/execution";
import { z } from "zod";
import type { JobDetail, JobLogger, JobName, JobOutcome, JobResult } from "./types.js";

/**
 * Retry hints, in milliseconds. Base produces a block every ~2s, so anything shorter is a
 * query the chain cannot yet answer differently.
 */
export const RETRY = {
  /** Another order holds the single signer; it advances one leg per settled receipt. */
  order: 4000,
  /** A broadcast leg needs WORKER_CONFIRMATIONS (default 3) blocks before it is observable. */
  receipt: 6000,
  /** An unexpected failure: back off past a transient RPC or pool outage before retrying. */
  failure: 10000,
} as const;

export type Failure = { code: string; detail: JobDetail; retryAfterMs: number | null };

/**
 * Losing leadership is fatal to the whole worker, not to one job: another process may now
 * hold the advisory lock and be signing with the same key. It must escape the handler so
 * the supervisor stops the cycle instead of retrying against a fenced database.
 */
export function rethrowFatal(error: unknown): void {
  if (error instanceof LeadershipLost) throw error;
}

/**
 * Collapse a thrown value into a stable code plus log-safe detail.
 *
 * Only errors this codebase authors contribute their message. A viem or pg error embeds the
 * RPC URL, the full JSON-RPC request body and — for a send failure — the raw signed
 * transaction inside `error.message`; observability's redaction matches FIELD PATHS, not
 * substrings, so a message copied into a log line would carry signed bytes straight past it.
 * Foreign errors therefore contribute their constructor name and a fingerprint: the first 12
 * hex characters of the SHA-256 of the message. That is enough to see that ten failures are
 * the same failure, and to match one against a message found in source, without printing it.
 */
export function classify(error: unknown): Failure {
  if (error instanceof RecoveryRequired)
    return { code: "recovery-required", detail: { reason: error.message }, retryAfterMs: null };
  if (error instanceof Problem)
    return {
      code: `problem-${error.code}`,
      detail: { status: error.status, title: error.title },
      retryAfterMs: null,
    };
  if (error instanceof z.ZodError)
    return { code: "invalid-payload", detail: { issues: error.issues.length }, retryAfterMs: null };
  const value = error instanceof Error ? error : undefined;
  return {
    code: "unexpected-error",
    detail: {
      errorName: value?.constructor.name ?? typeof error,
      errorFingerprint: value ? fingerprint(value.message) : null,
    },
    retryAfterMs: RETRY.failure,
  };
}

function fingerprint(message: string) {
  return createHash("sha256").update(message).digest("hex").slice(0, 12);
}

export function jobResult(fields: {
  job: JobName;
  outcome: JobOutcome;
  code: string;
  userId: string;
  instanceId?: string | null;
  executionId?: string | null;
  retryAfterMs?: number | null;
  detail?: JobDetail;
}): JobResult {
  return {
    job: fields.job,
    outcome: fields.outcome,
    code: fields.code,
    userId: fields.userId,
    instanceId: fields.instanceId ?? null,
    executionId: fields.executionId ?? null,
    retryAfterMs: fields.retryAfterMs ?? null,
    detail: fields.detail ?? {},
  };
}

/**
 * One log line per job. `detail` stays nested rather than spread so a future detail key
 * cannot shadow `code` or `outcome` and change what an operator's filter matches.
 */
export function record(log: JobLogger, result: JobResult): JobResult {
  const line = {
    job: result.job,
    outcome: result.outcome,
    code: result.code,
    userId: result.userId,
    instanceId: result.instanceId,
    executionId: result.executionId,
    retryAfterMs: result.retryAfterMs,
    detail: result.detail,
  };
  // Level follows what an operator must do, not how interesting the job felt. A scheduler
  // polling every WORKER_POLL_MS (2 s) re-dispatches a not-due instance and re-checks a
  // transaction that needs WORKER_CONFIRMATIONS blocks; logging those at warn would bury a
  // real fault under thousands of lines an hour. Only a block that NO timer resolves —
  // `execution-disabled`, `recovery-required`, a signer under operator recovery — is a
  // standing condition someone has to clear, so only that one warns.
  if (result.outcome === "failed") log.error(line, "Job failed");
  else if (result.outcome === "blocked")
    if (result.retryAfterMs === null) log.warn(line, "Job blocked; needs an operator");
    else log.info(line, "Job blocked; waiting");
  else if (result.outcome === "skipped") log.debug(line, "Job skipped");
  else log.info(line, "Job applied");
  return result;
}
