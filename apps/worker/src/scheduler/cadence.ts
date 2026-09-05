import { createHash } from "node:crypto";

/**
 * BaseReader caches a whole market snapshot for 15 seconds
 * (packages/evm/src/clients/base.ts). Two evaluations closer together than this
 * observe byte-identical feeds, so the second one cannot see a new price and
 * cannot fire an edge-triggered rule that the first did not. It is not a hard
 * floor — a user may legitimately want a tighter loop for balance-driven rules —
 * but scheduling below it is worth telling the owner about.
 */
export const MARKET_WINDOW_MS = 15_000;

/**
 * Admission's own failure floor: on a failed evaluation it writes
 * `now + max(30000, tickIntervalMs)` (packages/execution/src/admission.ts).
 * Backoff starts from exactly that value so the first retry after a failure is
 * never earlier than the one admission already committed.
 */
export const ADMISSION_FAILURE_FLOOR_MS = 30_000;

export type OutcomeClass =
  | "healthy"
  | "transient"
  | "policy"
  | "terminal"
  | "scheduler"
  | "unknown";

/**
 * Outcomes written by this scheduler rather than by admission. They share the
 * evaluations table so a skipped tick is visible in the owner's history, which
 * means every reader of that history has to be able to tell them apart from a
 * real evaluation.
 */
export const SCHEDULER_OUTCOMES = ["deferred", "late", "degraded"] as const;
export type SchedulerOutcome = (typeof SCHEDULER_OUTCOMES)[number];

export interface CadencePolicy {
  /** Never schedule anything closer than this; matches the schema's tick_interval_ms lower bound. */
  minCadenceMs: number;
  /** Uniform spread added on top of the deterministic grid, purely to decorrelate row writes. */
  spreadMs: number;
  /** First transient retry delay; raised to the instance's own interval when that is larger. */
  backoffFloorMs: number;
  backoffFactor: number;
  backoffMaxMs: number;
  /** Delay for outcomes that only change on operator action, not with time. */
  flatBackoffMs: number;
  /** How many recent evaluations are inspected to measure a failure streak. */
  streakWindow: number;
  /** Lateness beyond this many effective intervals is worth a durable record. */
  lateAfterTicks: number;
  /** ...but never write a lateness record for less than this, so a 1s cadence cannot spam. */
  lateFloorMs: number;
  /** Minimum gap between durable scheduler records for one instance. */
  recordIntervalMs: number;
  /** Schedule this long after caps.expires_at so the terminal transition fires promptly. */
  expiryGraceMs: number;
  /** EWMA smoothing for observed evaluation cost and observed lateness. */
  costDecay: number;
  /** A single evaluation cannot raise the cadence floor by more than this. */
  costCapMs: number;
  /**
   * A restart after downtime makes every instance hours late. That is a one-off
   * catch-up, not sustained throughput pressure, so lateness contributes to the
   * cadence floor only up to this cap.
   */
  latenessCapMs: number;
  /** Refuse to start beyond this much disagreement with the database clock. */
  maxClockSkewMs: number;
}

export const defaultCadencePolicy: CadencePolicy = {
  minCadenceMs: 1_000,
  spreadMs: 250,
  backoffFloorMs: ADMISSION_FAILURE_FLOOR_MS,
  backoffFactor: 2,
  backoffMaxMs: 1_800_000,
  flatBackoffMs: 60_000,
  streakWindow: 8,
  lateAfterTicks: 2,
  lateFloorMs: 30_000,
  recordIntervalMs: 60_000,
  expiryGraceMs: 1_000,
  costDecay: 0.2,
  costCapMs: 60_000,
  latenessCapMs: 120_000,
  maxClockSkewMs: 5_000,
};

export function resolvePolicy(overrides?: Partial<CadencePolicy>): CadencePolicy {
  const policy = { ...defaultCadencePolicy, ...overrides };
  if (policy.minCadenceMs < 1 || policy.backoffFactor <= 1 || policy.streakWindow < 1)
    throw new Error("Invalid cadence policy");
  return policy;
}

/**
 * A stable offset in [0, periodMs) derived only from the instance id. Two
 * instances therefore never share a due millisecond, and — unlike
 * `now + interval ± random` — the offset does not drift across worker restarts,
 * so a strategy keeps the same slot for its whole life.
 */
export function phaseOffset(instanceId: string, periodMs: number): number {
  if (periodMs <= 0) return 0;
  const hash = createHash("sha256").update(instanceId).digest();
  return hash.readUInt32BE(0) % periodMs;
}

/** Nearest point of the absolute grid `{ k * period + phase }` to `target`. */
export function alignTo(target: number, phase: number, period: number): number {
  if (period <= 0) return target;
  const up = (((phase - target) % period) + period) % period;
  // Snapping to the nearest grid point bounds the one-off correction after an
  // arm (whose lastTickAt is arbitrary) to ±half an interval. Snapping upward
  // only would double the very first gap after arming.
  return up <= period / 2 ? target + up : target + up - period;
}

/**
 * Exponential backoff with jitter that only ever runs *later* than the
 * deterministic delay. Classic equal jitter halves the mean, which would make
 * the first retry sooner than the 30s admission already committed; the RPC
 * budget (1200ms between requests, process-wide) makes retrying early the
 * expensive mistake, so the spread goes up, not down.
 *
 * `backoffMaxMs` caps the DETERMINISTIC term, not the returned delay, so the
 * realised wait is at most 1.5x it. Capping after the jitter would collapse the
 * spread exactly where it matters most: an RPC outage fails every armed instance
 * inside one cycle, they all reach the ceiling together, and a hard cap would
 * then release all of them on the same millisecond into an RPC that has just
 * come back — the thundering herd this function exists to prevent.
 */
export function backoffMs(
  streak: number,
  intervalMs: number,
  policy: CadencePolicy,
  random: () => number = Math.random,
): number {
  const base = Math.max(policy.backoffFloorMs, intervalMs);
  // 2^32 already overflows any sane ceiling; clamping the exponent keeps the
  // arithmetic finite so `Math.min` cannot be handed an Infinity.
  const steps = Math.min(Math.max(0, streak - 1), 32);
  const raw = Math.min(policy.backoffMaxMs, base * policy.backoffFactor ** steps);
  return Math.round(raw + random() * (raw / 2));
}

/**
 * How many *additional* scheduled evaluations were skipped before the one about
 * to run. Zero means on time. These are never replayed: replaying an hour of
 * backlogged evaluations against current prices would fire rules on stale
 * intent. One evaluation with fresh prices plus a record of the count is the
 * correct semantics for a trading strategy.
 */
export function missedTicks(dueAt: number, now: number, intervalMs: number): number {
  const interval = Math.max(1, intervalMs);
  return Math.max(0, Math.floor((now - dueAt) / interval));
}

export function classifyOutcome(outcome: string | undefined): OutcomeClass {
  switch (outcome) {
    case "evaluated":
      return "healthy";
    // Chain, oracle or authority could not be read, or the read went stale
    // before the write transaction committed. Time alone may fix these.
    case "observation-or-authority-unavailable":
    case "observation-expired":
      return "transient";
    // Process configuration. WORKER_EXECUTE only changes on restart, so doubling
    // to 30 minutes would leave instances idle long after an operator enables
    // execution; a flat retry keeps the recovery bounded.
    case "execution-disabled":
      return "policy";
    // Admission has already moved the instance out of `armed` (ended, halted or
    // paused). Writing a due time for it would resurrect a dead schedule.
    case "expired":
    case "halted":
    case "eligibility-renewal-required":
      return "terminal";
    case "deferred":
    case "late":
    case "degraded":
      return "scheduler";
    default:
      // An outcome this build does not know about must not be read as success
      // and must not trigger backoff. It gets the plain requested cadence.
      return "unknown";
  }
}

/** Newest outcome that admission actually produced, ignoring this scheduler's own rows. */
export function latestOutcome(newestFirst: readonly string[]): string | undefined {
  return newestFirst.find((outcome) => classifyOutcome(outcome) !== "scheduler");
}

/**
 * Length of the leading run of evaluations sharing `target`'s class, newest
 * first. Scheduler-written rows are transparent: a lateness record interleaved
 * with two failures must not reset the failure streak back to one and undo the
 * backoff that was protecting the RPC budget.
 */
export function outcomeStreak(newestFirst: readonly string[], target: OutcomeClass): number {
  let streak = 0;
  for (const outcome of newestFirst) {
    const observed = classifyOutcome(outcome);
    if (observed === "scheduler") continue;
    if (observed !== target) break;
    streak++;
  }
  return streak;
}

export interface DueInput {
  instanceId: string;
  /** Anchor for the next slot: the moment the evaluation actually ran. */
  from: number;
  /** The cadence the owner asked for. */
  intervalMs: number;
  /** The cadence this worker can actually sustain, from measured cost. */
  floorMs: number;
  outcome: OutcomeClass;
  streak: number;
  now: number;
  /** caps.expires_at in epoch milliseconds, when the strategy has one. */
  expiresAt?: number | undefined;
  policy: CadencePolicy;
  random?: (() => number) | undefined;
}

export function effectiveIntervalMs(
  intervalMs: number,
  floorMs: number,
  policy: CadencePolicy,
): number {
  return Math.max(policy.minCadenceMs, intervalMs, floorMs);
}

export function nextDueAt(input: DueInput): Date {
  const { policy } = input;
  const random = input.random ?? Math.random;
  const interval = effectiveIntervalMs(input.intervalMs, input.floorMs, policy);
  const delay =
    input.outcome === "transient"
      ? backoffMs(input.streak, interval, policy, random)
      : input.outcome === "policy"
        ? Math.max(policy.flatBackoffMs, interval)
        : interval;
  // Backoff is a deliberate departure from the grid; re-aligning it would snap a
  // 30-minute wait back onto a 12-second lattice and lose most of the delay.
  const aligned =
    input.outcome === "transient" || input.outcome === "policy"
      ? input.from + delay
      : alignTo(input.from + delay, phaseOffset(input.instanceId, interval), interval);
  let at = aligned + Math.floor(random() * policy.spreadMs);
  at = Math.max(at, input.now + policy.minCadenceMs);
  if (input.expiresAt !== undefined) {
    // A 30-minute backoff on a strategy that expires in 10 minutes would leave
    // it displayed as "armed" long after it is dead, because only an evaluation
    // performs the expiry -> ended transition. Never schedule past the expiry.
    const deadline = Math.max(
      input.now + policy.minCadenceMs,
      input.expiresAt + policy.expiryGraceMs,
    );
    at = Math.min(at, deadline);
  }
  return new Date(at);
}
