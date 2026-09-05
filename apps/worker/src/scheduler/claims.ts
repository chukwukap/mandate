import { createHash, randomUUID } from "node:crypto";

/**
 * Minimal shape of a pooled PostgreSQL connection. `pg.Pool` satisfies
 * `ClaimConnector` structurally, so nothing here imports a database singleton
 * and tests can supply a fake connector.
 */
export interface ClaimClient {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
  release(destroy?: boolean): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}
export interface ClaimConnector {
  connect(): Promise<ClaimClient>;
}

export type ClaimResult =
  | { held: true; generation: number }
  | { held: false; reason: "contended" | "unavailable" };

export interface ClaimsLog {
  debug(object: object, message?: string): void;
  warn(object: object, message?: string): void;
  error(object: object, message?: string): void;
}

/**
 * Advisory-lock key for one instance.
 *
 * Leadership uses the two-int32 form `pg_try_advisory_lock(8453, 2026)`
 * (packages/database/src/worker.ts). Instance claims use the single-bigint
 * form, and PostgreSQL keeps those two key spaces disjoint via distinct lock
 * tags, so no instance id can ever collide with the leadership lock. 64 bits of
 * SHA-256 also makes instance-to-instance collision negligible (~1e-14 at a
 * thousand instances), and a collision would only defer a tick, never lose one.
 */
export function claimKey(instanceId: string): bigint {
  return createHash("sha256").update(instanceId).digest().readBigInt64BE(0);
}

const TRY_LOCK = "select pg_try_advisory_lock($1::bigint) as held";
const UNLOCK = "select pg_advisory_unlock($1::bigint) as released";
const UNLOCK_ALL = "select pg_advisory_unlock_all()";

/**
 * Per-instance session advisory locks on one dedicated pooled connection.
 *
 * Advisory rather than a `claimed_until` column because a session lock is
 * released by PostgreSQL the instant the connection dies — a `SIGKILL`ed worker
 * frees its claims immediately, where a lease column would freeze every claimed
 * instance until its expiry, and a lease short enough to avoid that
 * double-evaluates under a slow RPC read. It also costs zero writes: claiming a
 * thousand instances every 12 seconds through a column would be ~83
 * bookkeeping UPDATEs per second of WAL and dead tuples for pure bookkeeping.
 *
 * Requires direct connections or session-mode pooling; transaction-mode
 * PgBouncer cannot preserve a session lock. That constraint already exists for
 * the leadership lock, so this adds nothing new to the runbook.
 */
export class InstanceClaims {
  private client: ClaimClient | undefined;
  private connecting: Promise<ClaimClient | undefined> | undefined;
  private generation = 1;
  private readonly held = new Map<string, string>();
  private blockedUntil = 0;
  constructor(
    private readonly connector: ClaimConnector,
    private readonly log: ClaimsLog,
    private readonly now: () => number = () => Date.now(),
    private readonly reconnectCooldownMs = 5_000,
  ) {}

  /** Current connection generation; a claim taken under an older one is void. */
  get epoch(): number {
    return this.generation;
  }
  get outstanding(): number {
    return this.held.size;
  }

  /**
   * Prove the connection can take and drop an advisory lock. Called from
   * readiness so a database role without permission, or an unreachable pooler,
   * fails at startup rather than silently degrading every cycle.
   */
  async probe(): Promise<boolean> {
    const client = await this.open();
    if (!client) return false;
    try {
      // A per-process key, not a constant: two workers starting at once would
      // contend on a shared probe key and the loser would report a permission
      // problem it does not have.
      const key = claimKey(`mandate:scheduler:probe:${randomUUID()}`).toString();
      const { rows } = await client.query<{ held: boolean }>(TRY_LOCK, [key]);
      await client.query(UNLOCK, [key]);
      return rows[0]?.held === true;
    } catch {
      this.discard("probe failed");
      return false;
    }
  }

  async acquire(instanceId: string): Promise<ClaimResult> {
    // Session advisory locks are re-entrant: a second pg_try_advisory_lock on
    // the same key in the same session succeeds again and needs a second
    // unlock. Tracking held keys locally is what stops a leaked claim from
    // being silently re-taken by this same process.
    if (this.held.has(instanceId)) return { held: false, reason: "contended" };
    const client = await this.open();
    if (!client) return { held: false, reason: "unavailable" };
    const key = claimKey(instanceId).toString();
    try {
      const { rows } = await client.query<{ held: boolean }>(TRY_LOCK, [key]);
      if (rows[0]?.held !== true) return { held: false, reason: "contended" };
      this.held.set(instanceId, key);
      return { held: true, generation: this.generation };
    } catch {
      // A statement timeout or a dropped socket leaves the session's lock state
      // unknown. Throw the connection away rather than reason about it.
      this.discard("claim query failed");
      return { held: false, reason: "unavailable" };
    }
  }

  async release(instanceId: string, generation: number): Promise<void> {
    const key = this.held.get(instanceId);
    this.held.delete(instanceId);
    if (generation !== this.generation) {
      // The connection was replaced since the claim was taken. Every lock it
      // held evaporated with it; unlocking on the new session would be a no-op
      // at best and would unlock a lock this process never took at worst.
      this.log.warn({ instance: instanceId }, "Instance claim lost with its connection");
      return;
    }
    if (!key || !this.client) return;
    try {
      await this.client.query(UNLOCK, [key]);
    } catch {
      this.discard("release query failed");
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.held.clear();
    this.client = undefined;
    this.connecting = undefined;
    this.generation++;
    if (!client) return;
    try {
      await client.query(UNLOCK_ALL);
    } catch {
      // Destroying the connection below releases every session lock anyway.
    } finally {
      client.release(true);
    }
  }

  private async open(): Promise<ClaimClient | undefined> {
    if (this.client) return this.client;
    // A failed pool connect costs the full 5s connectionTimeoutMillis. Retrying
    // it on every instance of every 2s cycle would stall the whole tick loop
    // behind a database that is already down, so back off before trying again.
    if (this.now() < this.blockedUntil) return undefined;
    // One connect attempt shared by every caller in this cycle, so a burst of
    // due instances cannot open a dozen connections into a 12-slot pool.
    if (!this.connecting) this.connecting = this.connect();
    const pending = this.connecting;
    try {
      return await pending;
    } finally {
      this.connecting = undefined;
    }
  }

  private async connect(): Promise<ClaimClient | undefined> {
    try {
      const client = await this.connector.connect();
      client.on("error", () => this.discard("connection error"));
      this.client = client;
      return client;
    } catch {
      this.blockedUntil = this.now() + this.reconnectCooldownMs;
      this.log.warn(
        { cooldownMs: this.reconnectCooldownMs },
        "Scheduler could not open its claim connection; evaluating without exclusive claims",
      );
      return undefined;
    }
  }

  private discard(reason: string) {
    const client = this.client;
    this.client = undefined;
    this.held.clear();
    // Every outstanding claim was taken on this connection, so bumping the
    // generation is what makes them all report themselves as lost instead of
    // being released against a fresh session that never held them.
    this.generation++;
    this.blockedUntil = this.now() + this.reconnectCooldownMs;
    this.log.warn({ reason, generation: this.generation }, "Scheduler claim connection discarded");
    try {
      client?.release(true);
    } catch {
      // The pool already discarded it.
    }
  }
}
