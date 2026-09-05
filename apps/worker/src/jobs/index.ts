import type { WorkerConfig } from "@mandate/config";
import type { WorkerStore } from "@mandate/database";
import { Admission, type Executor, Lifecycle, type Observations } from "@mandate/execution";
import { evaluateInstance } from "./evaluate-instance.js";
import { executeIntent } from "./execute-intent.js";
import {
  type EvaluateInstancePayload,
  type ExecuteIntentPayload,
  type Job,
  type JobDependencies,
  type JobLogger,
  type JobResult,
  jobSchema,
} from "./types.js";

export { evaluateInstance } from "./evaluate-instance.js";
export { executeIntent } from "./execute-intent.js";
export { RETRY } from "./outcomes.js";
export type {
  AdmissionRunner,
  EvaluateInstancePayload,
  ExecuteIntentPayload,
  Job,
  JobDependencies,
  JobDetail,
  JobLogger,
  JobName,
  JobOutcome,
  JobResult,
  LifecycleRunner,
} from "./types.js";
export {
  evaluateInstancePayloadSchema,
  executeIntentPayloadSchema,
  jobNames,
  jobSchema,
} from "./types.js";

/**
 * Route one queue entry to its handler.
 *
 * The payload is validated here rather than inside each handler so there is exactly one
 * boundary between the queue and durable state. An unparseable entry THROWS instead of
 * returning a `JobResult`: every result is keyed by an owner, and a malformed payload has
 * no trustworthy owner to key one to. A scheduler must dead-letter it — retrying a
 * payload that failed a schema check will fail the same way forever.
 */
export async function dispatch(deps: JobDependencies, job: unknown): Promise<JobResult> {
  const parsed: Job = jobSchema.parse(job);
  return parsed.name === "evaluate-instance"
    ? evaluateInstance(deps, parsed.payload)
    : executeIntent(deps, parsed.payload);
}

export type WorkerJobs = JobDependencies & {
  dispatch(job: unknown): Promise<JobResult>;
  evaluateInstance(payload: EvaluateInstancePayload): Promise<JobResult>;
  executeIntent(payload: ExecuteIntentPayload): Promise<JobResult>;
};

/**
 * Build the job dependencies from worker configuration.
 *
 * This is the same wiring `Worker`'s constructor does today — deliberately copied rather
 * than moved, because `worker.ts` is owned elsewhere. Once the scheduler dispatches these
 * handlers, its inline `new Admission(...)` / `new Lifecycle(...)` should be deleted so
 * there is one place where the execution collaborators are configured.
 *
 * `executeEnabled` mirrors `config.execute`, which `loadWorkerConfig` only allows to be
 * true when a worker private key, a spender address and an explicit non-US
 * eligible-country allowlist are all configured. That the key actually controls that
 * spender address is checked where the key is loaded, in `WorkerChain`'s constructor.
 */
export function createWorkerJobs(
  config: WorkerConfig,
  store: WorkerStore,
  chain: Observations & Executor,
  log: JobLogger,
  now: () => Date = () => new Date(),
): WorkerJobs {
  const deps: JobDependencies = {
    store,
    admission: new Admission(store, chain, config.origin, config.execute, config.eligibleCountries),
    lifecycle: new Lifecycle(store, chain, config.receiptTimeoutMs),
    executeEnabled: config.execute,
    log,
    now,
  };
  return {
    ...deps,
    dispatch: (job) => dispatch(deps, job),
    evaluateInstance: (payload) => evaluateInstance(deps, payload),
    executeIntent: (payload) => executeIntent(deps, payload),
  };
}
