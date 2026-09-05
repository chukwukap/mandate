import { Problem } from "@mandate/contracts";
import type { DraftRow, InstanceRow, Transaction, WorkerStore } from "@mandate/database";
import { schema } from "@mandate/database";
import { desc, eq, sql } from "drizzle-orm";
import { Backlog } from "./backlog.js";
import {
  ADMISSION_FAILURE_FLOOR_MS,
  backoffMs,
  type CadencePolicy,
  classifyOutcome,
  effectiveIntervalMs,
  latestOutcome,
  missedTicks,
  nextDueAt,
  outcomeStreak,
  resolvePolicy,
} from "./cadence.js";
import { type ClaimConnector, InstanceClaims } from "./claims.js";

/** Ceiling on every per-instance in-process map, so a long-lived worker cannot grow forever. */
const MAX_TRACKED = 5_000;

export interface SchedulerLog {
  debug(object: object, message?: string): void;
  info(object: object, message?: string): void;
  warn(object: object, message?: string): void;
  error(object: object, message?: string): void;
}

export interface SchedulerDeps {
  store: WorkerStore;
  connector: ClaimConnector;
  log: SchedulerLog;
  policy?: Partial<CadencePolicy> | undefined;
  now?: (() => number) | undefined;
  random?: (() => number) | undefined;
}

/** Opaque token returned by `claim` and required by `settle`/`abandon`. */
export interface Claim {
  instanceId: string;
  userId: string;
  intervalMs: number;
  claimedAt: number;
  latenessMs: number;
  missedTicks: number;
  expiresAt: number | undefined;
  /** Claim-connection generation; a mismatch at release means the lock was lost. */
  generation: number;
  /** False when the claim connection was unavailable and the tick ran unclaimed. */
  exclusive: boolean;
}

/** Process-lifetime counters for one operator log line. Nothing here gates a decision. */
export interface SchedulerStats {
  /** Ticks this scheduler admitted for evaluation, exclusive or not. */
  claimed: number;
  /** Ticks skipped because another worker held the instance's advisory lock. */
  contended: number;
  /** Subset of `claimed` that ran WITHOUT an exclusive lock, the claim connection being down. */
  unclaimed: number;
  /** Ticks skipped in process because a previous settle could not write a due time. */
  gated: number;
  rescheduled: number;
  settleFailures: number;
  records: { written: number; suppressed: number; failed: number };
  evalMsEwma: number | undefined;
  latenessMsEwma: number | undefined;
  cadenceFloorMs: number;
}

/**
 * The scheduling policy that `Worker.cycle` consults. It owns no loop of its
 * own: `worker.ts` still pages owners and reads due instances, and this decides
 * whether a due instance is evaluated now and when it becomes due again.
 *
 * Expected call shape, around the existing `admission.run`:
 *
 *   const claim = await scheduler.claim(instance, draft);
 *   if (!claim) continue;
 *   try { await this.admission.run(instance, draft); }
 *   finally { await scheduler.settle(claim); }
 */
export class Scheduler {
  private readonly store: WorkerStore;
  private readonly log: SchedulerLog;
  private readonly policy: CadencePolicy;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly claims: InstanceClaims;
  private readonly backlog: Backlog;
  /**
   * Instances deferred in process because their durable due time could not be
   * written. Without this, an instance whose settle write keeps failing is
   * re-read as due on every 2s cycle and burns the RPC budget forever.
   */
  private readonly gates = new Map<string, number>();
  /**
   * Failure streaks for the path that leaves no evaluation row at all — a throw
   * out of admission, or a write that never committed. Durable backoff is read
   * from the evaluations table, which by definition has nothing to say here.
   * The `at` alongside the count is what lets the map be trimmed by age; a bare
   * count is indistinguishable from a timestamp and trimming on it silently
   * erases every streak. Resetting on restart is deliberate: a fresh process
   * should retry once before concluding anything about the chain.
   */
  private readonly throwStreaks = new Map<string, { streak: number; at: number }>();
  private evalMsEwma: number | undefined;
  private latenessMsEwma: number | undefined;
  private counters = {
    claimed: 0,
    contended: 0,
    unclaimed: 0,
    gated: 0,
    rescheduled: 0,
    settleFailures: 0,
  };

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.log = deps.log;
    this.policy = resolvePolicy(deps.policy);
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
    this.claims = new InstanceClaims(deps.connector, deps.log, this.now);
    this.backlog = new Backlog(deps.store, deps.log, this.policy, this.now);
  }

  /**
   * `next_tick_at` is a PostgreSQL timestamp compared against this process's
   * clock. A worker a minute behind sees nothing due and silently stops trading;
   * a minute ahead fires every instance continuously. A 12s cadence is
   * meaningless under either, so refuse to start rather than trade badly.
   */
  async ready(): Promise<boolean> {
    const before = this.now();
    // clock_timestamp(), not now(): now() is the enclosing transaction's start
    // time, so on a pooled connection that has been sitting in a transaction it
    // would report an arbitrarily old instant and manufacture a skew failure.
    const result = await this.store.db.execute<{ at: Date | string }>(
      sql`select clock_timestamp() as at`,
    );
    const after = this.now();
    const value = result.rows[0]?.at;
    const server = value instanceof Date ? value.getTime() : Date.parse(String(value));
    if (!Number.isFinite(server))
      throw new Problem(
        503,
        "worker-clock-unreadable",
        "Database clock unreadable",
        "The worker could not read the database clock and cannot schedule evaluations.",
      );
    const roundTrip = after - before;
    // The estimate is only as good as the round trip: half of it is the
    // irreducible error in the midpoint. A round trip larger than the skew
    // budget cannot prove or disprove skew, so it is its own failure with its
    // own remedy rather than being reported as a wrong clock.
    if (roundTrip > this.policy.maxClockSkewMs)
      throw new Problem(
        503,
        "worker-clock-unmeasurable",
        "Database too slow to time",
        `Reading the database clock took ${roundTrip}ms, more than the ${this.policy.maxClockSkewMs}ms skew budget, so clock agreement cannot be established. Check database latency before starting the worker.`,
      );
    const skew = Math.abs(server - (before + after) / 2);
    if (skew > this.policy.maxClockSkewMs)
      throw new Problem(
        503,
        "worker-clock-skew",
        "Worker clock skew",
        `The worker clock differs from the database clock by about ${Math.round(skew)}ms (round trip ${roundTrip}ms). Synchronise the worker host clock before arming strategies.`,
      );
    if (!(await this.claims.probe()))
      this.log.warn(
        {},
        "Scheduler could not take an advisory lock; evaluations will run without exclusive claims",
      );
    this.log.info({ skewMs: Math.round(skew), roundTripMs: roundTrip }, "Scheduler ready");
    return true;
  }

  /**
   * Decide whether this due instance is evaluated now. `undefined` means skip
   * it without spending cycle budget on it.
   */
  async claim(instance: InstanceRow, draft: DraftRow): Promise<Claim | undefined> {
    const now = this.now();
    const gate = this.gates.get(instance.id);
    if (gate !== undefined) {
      if (gate > now) {
        this.counters.gated++;
        this.log.debug(
          { instance: instance.id, forMs: gate - now },
          "Instance deferred in process after a failed reschedule",
        );
        return undefined;
      }
      this.gates.delete(instance.id);
    }
    const claim = await this.claims.acquire(instance.id);
    if (!claim.held && claim.reason === "contended") {
      // Another worker — realistically a superseded leader still finishing a
      // cycle — is inside this instance's evaluation. Its write will be fenced
      // by the leadership generation, so this is about not paying for the same
      // RPC reads twice, not about correctness.
      this.counters.contended++;
      this.log.debug({ instance: instance.id }, "Instance claimed by another worker");
      return undefined;
    }
    if (!claim.held) this.counters.unclaimed++;
    const interval = this.effectiveInterval(instance.tickIntervalMs);
    const latenessMs = Math.max(0, now - instance.nextTickAt.getTime());
    const missed = missedTicks(instance.nextTickAt.getTime(), now, interval);
    this.latenessMsEwma = this.smooth(
      this.latenessMsEwma,
      Math.min(latenessMs, this.policy.latenessCapMs),
    );
    this.counters.claimed++;
    const threshold = Math.max(this.policy.lateFloorMs, this.policy.lateAfterTicks * interval);
    if (latenessMs >= threshold)
      // Recorded before the evaluation runs, so a tick that is both late and
      // then fails still leaves the lateness on the record.
      await this.backlog.note({
        kind: "late",
        instanceId: instance.id,
        userId: instance.userId,
        latenessMs,
        missedTicks: missed,
        requestedIntervalMs: instance.tickIntervalMs,
        effectiveIntervalMs: interval,
        pressure: () => this.backlog.pressure(instance.userId, now),
      });
    const expiresAt = Date.parse(draft.envelope.caps.expires_at);
    return {
      instanceId: instance.id,
      userId: instance.userId,
      intervalMs: instance.tickIntervalMs,
      claimedAt: now,
      latenessMs,
      missedTicks: missed,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
      generation: claim.held ? claim.generation : this.claims.epoch,
      exclusive: claim.held,
    };
  }

  /**
   * Release the claim and set the next due time. Safe to call from a `finally`:
   * it never throws, because throwing here would mask the admission failure that
   * is the real reason the tick did not complete.
   *
   * That includes swallowing `LeadershipLost`, which is fatal everywhere else.
   * It is safe here only because this is not where leadership loss is detected:
   * `Worker.cycle` calls `lease.heartbeat()` at the top of every cycle and
   * `main.ts` beats it again every 10s, either of which aborts the process. All
   * this scheduler does in the meantime is defer instances it could not write,
   * which is the correct behaviour against a fenced database anyway.
   */
  async settle(claim: Claim): Promise<void> {
    const finished = this.now();
    this.evalMsEwma = this.smooth(
      this.evalMsEwma,
      Math.min(Math.max(0, finished - claim.claimedAt), this.policy.costCapMs),
    );
    try {
      await this.reschedule(claim);
    } catch {
      this.counters.settleFailures++;
      const streak = this.bumpStreak(claim.instanceId);
      const wait = backoffMs(streak, claim.intervalMs, this.policy, this.random);
      this.gates.set(claim.instanceId, this.now() + wait);
      this.trimGates();
      this.log.error(
        { instance: claim.instanceId, streak, waitMs: wait },
        "Scheduler could not write the next due time; deferring this instance in process",
      );
    } finally {
      await this.claims.release(claim.instanceId, claim.generation);
    }
  }

  /** Release a claim without touching the schedule, for a cycle aborted before evaluation. */
  async abandon(claim: Claim): Promise<void> {
    await this.claims.release(claim.instanceId, claim.generation);
  }

  async close(): Promise<void> {
    await this.claims.close();
  }

  stats(): SchedulerStats {
    return {
      ...this.counters,
      records: this.backlog.counters,
      evalMsEwma: this.evalMsEwma === undefined ? undefined : Math.round(this.evalMsEwma),
      latenessMsEwma:
        this.latenessMsEwma === undefined ? undefined : Math.round(this.latenessMsEwma),
      cadenceFloorMs: this.cadenceFloor(),
    };
  }

  /**
   * The cadence this worker can actually sustain, from measurement rather than
   * from a model. `pacedFetch` serialises every RPC request 1200ms apart
   * process-wide, so evaluations are strictly serial and a cold market read costs
   * on the order of ten seconds; honouring a 12s `tick_interval_ms` for more
   * than two or three armed instances would build an unbounded backlog in which
   * every instance is permanently late. Observed cost sets the hard floor, and
   * observed lateness is the backlog term: if the queue runs L ms behind on
   * average, pushing every due time out by L is what lets it drain.
   */
  private cadenceFloor(): number {
    if (this.evalMsEwma === undefined) return this.policy.minCadenceMs;
    return Math.max(
      this.policy.minCadenceMs,
      Math.round(this.evalMsEwma + (this.latenessMsEwma ?? 0)),
    );
  }

  private effectiveInterval(intervalMs: number): number {
    return effectiveIntervalMs(intervalMs, this.cadenceFloor(), this.policy);
  }

  private smooth(previous: number | undefined, sample: number): number {
    return previous === undefined ? sample : previous + this.policy.costDecay * (sample - previous);
  }

  /** Gates expire on their own deadline, so an elapsed gate is always safe to drop. */
  private trimGates() {
    if (this.gates.size <= MAX_TRACKED) return;
    const now = this.now();
    for (const [key, until] of this.gates) if (until <= now) this.gates.delete(key);
    for (const key of this.gates.keys()) {
      if (this.gates.size <= MAX_TRACKED) break;
      this.gates.delete(key);
    }
  }

  /**
   * Streaks older than the longest backoff cannot still be describing a live
   * failure run, so dropping them is a reset, not a loss.
   */
  private trimStreaks() {
    if (this.throwStreaks.size <= MAX_TRACKED) return;
    const stale = this.now() - this.policy.backoffMaxMs;
    for (const [key, value] of this.throwStreaks)
      if (value.at < stale) this.throwStreaks.delete(key);
    for (const key of this.throwStreaks.keys()) {
      if (this.throwStreaks.size <= MAX_TRACKED) break;
      this.throwStreaks.delete(key);
    }
  }

  /** Increment and store a streak for the no-evaluation-row path. */
  private bumpStreak(instanceId: string): number {
    const streak = (this.throwStreaks.get(instanceId)?.streak ?? 0) + 1;
    this.throwStreaks.set(instanceId, { streak, at: this.now() });
    this.trimStreaks();
    return streak;
  }

  private async reschedule(claim: Claim): Promise<void> {
    await this.store.write(claim.userId, async (tx) => {
      const current = await this.store.lockInstance(tx, claim.instanceId);
      const now = this.now();
      // Not armed any more: admission ended, halted or paused it. Writing a due
      // time now would resurrect a dead schedule.
      if (current.status !== "armed") {
        this.throwStreaks.delete(claim.instanceId);
        this.backlog.clear(claim.instanceId);
        return;
      }
      const evaluated =
        current.lastTickAt !== null && current.lastTickAt.getTime() >= claim.claimedAt;
      if (!evaluated) return this.recoverUnevaluated(tx, claim, current, now);
      this.throwStreaks.delete(claim.instanceId);
      const history = await tx
        .select({ outcome: schema.evaluations.outcome })
        .from(schema.evaluations)
        .where(eq(schema.evaluations.instanceId, claim.instanceId))
        // `at` has millisecond precision and this scheduler writes its own rows
        // inside the same transaction as an evaluation, so two rows can share it.
        // The id tiebreak keeps the streak walk deterministic.
        .orderBy(desc(schema.evaluations.at), desc(schema.evaluations.id))
        .limit(this.policy.streakWindow);
      const outcomes = history.map((row) => row.outcome);
      const outcome = classifyOutcome(latestOutcome(outcomes));
      if (outcome === "terminal") return;
      // Repository.transition("arm") deliberately sets next_tick_at = now to
      // force an immediate evaluation. Overwriting that would make the user's
      // Arm button look dead for a whole backoff period, so only adjust a due
      // time that still has exactly the shape admission itself just wrote.
      const anchor = current.lastTickAt?.getTime() ?? claim.claimedAt;
      const written = new Set([
        anchor + current.tickIntervalMs,
        anchor + Math.max(ADMISSION_FAILURE_FLOOR_MS, current.tickIntervalMs),
      ]);
      if (!written.has(current.nextTickAt.getTime())) {
        this.log.debug(
          { instance: claim.instanceId },
          "Instance was rescheduled concurrently; leaving its due time alone",
        );
        return;
      }
      const interval = this.effectiveInterval(current.tickIntervalMs);
      const at = nextDueAt({
        instanceId: claim.instanceId,
        from: anchor,
        intervalMs: current.tickIntervalMs,
        floorMs: this.cadenceFloor(),
        outcome,
        streak: outcomeStreak(outcomes, outcome),
        now,
        expiresAt: claim.expiresAt,
        policy: this.policy,
        random: this.random,
      });
      await tx
        .update(schema.instances)
        // updatedAt is deliberately untouched: it is the owner-visible mutation
        // timestamp and admission's staleness guard compares it. A scheduling
        // adjustment is not a state transition.
        .set({ nextTickAt: at })
        .where(eq(schema.instances.id, claim.instanceId));
      this.counters.rescheduled++;
      if (outcome === "healthy") this.backlog.clear(claim.instanceId);
      if (interval > current.tickIntervalMs)
        await this.backlog.note(
          {
            kind: "degraded",
            instanceId: claim.instanceId,
            userId: claim.userId,
            latenessMs: claim.latenessMs,
            missedTicks: claim.missedTicks,
            requestedIntervalMs: current.tickIntervalMs,
            effectiveIntervalMs: interval,
          },
          tx,
        );
    });
  }

  /**
   * Admission committed nothing. Either it threw before its write transaction,
   * or it found the row stale and returned without changing it. The instance
   * still being due is what separates the two: if something else had advanced
   * it, it would no longer be due.
   */
  private async recoverUnevaluated(
    tx: Transaction,
    claim: Claim,
    current: InstanceRow,
    now: number,
  ): Promise<void> {
    if (current.nextTickAt.getTime() > now) {
      this.throwStreaks.delete(claim.instanceId);
      return;
    }
    const streak = this.bumpStreak(claim.instanceId);
    const at = nextDueAt({
      instanceId: claim.instanceId,
      from: now,
      intervalMs: current.tickIntervalMs,
      floorMs: this.cadenceFloor(),
      outcome: "transient",
      streak,
      now,
      expiresAt: claim.expiresAt,
      policy: this.policy,
      random: this.random,
    });
    await tx
      .update(schema.instances)
      .set({ nextTickAt: at })
      .where(eq(schema.instances.id, claim.instanceId));
    this.counters.rescheduled++;
    // The whole point of the requirement: a tick that produced no evaluation
    // must still leave a trace the owner can see.
    await this.backlog.note(
      {
        kind: "deferred",
        instanceId: claim.instanceId,
        userId: claim.userId,
        latenessMs: claim.latenessMs,
        missedTicks: claim.missedTicks,
        requestedIntervalMs: current.tickIntervalMs,
        effectiveIntervalMs: this.effectiveInterval(current.tickIntervalMs),
        detail: `Retry ${streak} scheduled for ${at.toISOString()}.`,
      },
      tx,
    );
  }
}
