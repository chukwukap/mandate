import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type pg from "pg";
import { type Database, type Transaction, tenant } from "./client.js";
import { drafts, executions, instances, transactions, users, workerState } from "./schema/index.js";

export class LeadershipLost extends Error {}
export class WorkerLease {
  readonly generation = randomUUID();
  private client: pg.PoolClient | undefined;
  private alive = false;
  private executionAvailable = false;
  constructor(
    private readonly pool: pg.Pool,
    readonly db: Database,
  ) {}
  async acquire() {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ held: boolean }>(
        "select pg_try_advisory_lock(8453, 2026) as held",
      );
      if (!result.rows[0]?.held) {
        client.release();
        return false;
      }
      this.client = client;
      this.alive = true;
      client.on("error", () => {
        this.alive = false;
      });
      await this.db
        .insert(workerState)
        .values({
          id: 1,
          generation: this.generation,
          heartbeatAt: new Date(),
          executionAvailable: 0,
        })
        .onConflictDoUpdate({
          target: workerState.id,
          set: { generation: this.generation, heartbeatAt: new Date(), executionAvailable: 0 },
        });
      return true;
    } catch (error) {
      this.alive = false;
      client.release(true);
      this.client = undefined;
      throw error;
    }
  }
  async heartbeat(execute?: boolean) {
    if (execute !== undefined) this.executionAvailable = execute;
    if (!this.alive || !this.client) throw new LeadershipLost();
    await this.client.query("select 1");
    const rows = await this.db
      .update(workerState)
      .set({ heartbeatAt: new Date(), executionAvailable: this.executionAvailable ? 1 : 0 })
      .where(and(eq(workerState.id, 1), eq(workerState.generation, this.generation)))
      .returning();
    if (!rows.length) {
      this.alive = false;
      throw new LeadershipLost();
    }
  }
  async assert(tx: Transaction) {
    if (!this.alive) throw new LeadershipLost();
    const [row] = await tx.select().from(workerState).where(eq(workerState.id, 1)).for("share");
    if (row?.generation !== this.generation || Date.now() - row.heartbeatAt.getTime() > 30000)
      throw new LeadershipLost();
  }
  async close() {
    this.alive = false;
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    try {
      await this.db
        .update(workerState)
        .set({ executionAvailable: 0, heartbeatAt: new Date(0) })
        .where(eq(workerState.generation, this.generation));
      await client.query("select pg_advisory_unlock(8453, 2026)");
    } finally {
      client.release(true);
    }
  }
}
export async function workerAvailable(db: Database) {
  const [row] = await db.select().from(workerState).where(eq(workerState.id, 1));
  return row?.executionAvailable === 1 && Date.now() - row.heartbeatAt.getTime() < 30000;
}
export class WorkerStore {
  private cursor: string | undefined;
  constructor(
    readonly db: Database,
    readonly lease: Pick<WorkerLease, "assert">,
  ) {}
  async write<T>(user: string, run: (tx: Transaction) => Promise<T>): Promise<T> {
    return tenant(this.db, user, async (tx) => {
      await this.lease.assert(tx);
      return run(tx);
    });
  }
  // Walk a bounded page of owners, including inactive owners with pending recovery.
  async owners(limit: number) {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(this.cursor ? gt(users.id, this.cursor) : undefined)
      .orderBy(asc(users.id))
      .limit(limit);
    this.cursor = rows.length === limit ? rows.at(-1)?.id : undefined;
    return rows.map((r) => r.id);
  }
  async due(user: string, limit: number, now = new Date()) {
    return tenant(this.db, user, (tx) =>
      tx
        .select({ instance: instances, draft: drafts })
        .from(instances)
        .innerJoin(drafts, eq(drafts.id, instances.draftId))
        .where(and(eq(instances.status, "armed"), lte(instances.nextTickAt, now)))
        .orderBy(asc(instances.nextTickAt), asc(instances.id))
        .limit(limit),
    );
  }
  async context(user: string, id: string) {
    return tenant(this.db, user, async (tx) => {
      const [row] = await tx
        .select({ instance: instances, draft: drafts })
        .from(instances)
        .innerJoin(drafts, eq(drafts.id, instances.draftId))
        .where(eq(instances.id, id));
      if (!row) throw new Error("Instance unavailable");
      // The owner's Privy identity travels with the context: it is how the worker asks Privy
      // for the embedded wallet that signs this strategy's orders.
      const [owner] = await tx
        .select({ id: users.id, privyDid: users.privyDid })
        .from(users)
        .where(eq(users.id, user));
      if (!owner) throw new Error("Owner unavailable");
      return { ...row, owner };
    });
  }
  async pending(user: string, limit: number) {
    return tenant(this.db, user, (tx) =>
      tx
        .select()
        .from(executions)
        .where(inArray(executions.status, ["admitted", "pending", "recovery_required"]))
        .orderBy(asc(executions.createdAt), asc(executions.id))
        .limit(limit),
    );
  }
  async journal(user: string, executionId: string) {
    return tenant(this.db, user, (tx) =>
      tx
        .select()
        .from(transactions)
        .where(eq(transactions.executionId, executionId))
        .orderBy(asc(transactions.nonce)),
    );
  }
  async activeExecution() {
    // RLS means we must enter each owner's context. Global signer ownership is
    // serialized by the leader; an outstanding order blocks new admissions.
    let cursor: string | undefined;
    for (;;) {
      const owners = await this.db
        .select({ id: users.id })
        .from(users)
        .where(cursor ? gt(users.id, cursor) : undefined)
        .orderBy(asc(users.id))
        .limit(100);
      for (const owner of owners) {
        const [execution] = await this.pending(owner.id, 1);
        if (execution) return execution;
      }
      if (owners.length < 100) break;
      cursor = owners.at(-1)?.id;
    }
    return undefined;
  }
  async lockInstance(tx: Transaction, id: string) {
    const [instance] = await tx.select().from(instances).where(eq(instances.id, id)).for("update");
    if (!instance) throw new Error("Instance unavailable");
    return instance;
  }
  async ready() {
    await this.db.execute(sql`select generation from mandate_v2.worker_state limit 0`);
    await this.db.execute(sql`select hash, raw_transaction from mandate_v2.transactions limit 0`);
  }
}
