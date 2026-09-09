import { randomUUID } from "node:crypto";
import { Problem } from "@mandate/contracts";
import { initialRuntime } from "@mandate/strategy";
import { and, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { type Database, type Transaction, tenant } from "../client.js";
import {
  type DraftRow,
  drafts,
  evaluations,
  executions,
  type InstanceRow,
  instances,
  users,
} from "../schema/index.js";

export class Repository {
  constructor(public readonly db: Database) {}

  /**
   * The local row for a Privy DID, created on first sight.
   *
   * `onConflictDoNothing`, not `onConflictDoUpdate`. The update form needs the UPDATE privilege,
   * and infra/postgres/03-grants.sql grants the API only SELECT and INSERT on this table on
   * purpose: a user row is written once and never mutated, so the ability to rewrite one is
   * authority the API has no use for. The upsert only ever set `privy_did` to the value it
   * already held — a no-op that existed to make RETURNING fire — so nothing is lost by dropping
   * it, and the grant no longer has to be widened to accommodate a write that never wrote.
   *
   * This surfaced the moment the grants script was applied as written: every sign-in answered
   * 500 with "permission denied for table users", which reached the browser as a generic "The
   * request could not be completed" on every page at once.
   *
   * The follow-up SELECT is the conflict path, and it is not a race: the unique index on
   * `privy_did` means whoever lost the insert is reading a row that is already committed.
   */
  async resolvePrivyUser(privyDid: string) {
    const [inserted] = await this.db
      .insert(users)
      .values({ id: randomUUID(), privyDid })
      .onConflictDoNothing({ target: users.privyDid })
      .returning();
    if (inserted) return inserted;
    const [existing] = await this.db.select().from(users).where(eq(users.privyDid, privyDid));
    if (!existing) throw new Error("User resolution failed");
    return existing;
  }
  async saveDraft(row: typeof drafts.$inferInsert) {
    await tenant(this.db, row.userId, async (tx) => {
      await tx.insert(drafts).values(row);
    });
  }
  async draft(user: string, artifact: string) {
    return tenant(this.db, user, async (tx) => {
      const [row] = await tx
        .select()
        .from(drafts)
        .where(and(eq(drafts.userId, user), eq(drafts.artifactId, artifact)));
      return row;
    });
  }
  async createInstance(
    user: string,
    draft: DraftRow,
    signature: string,
    name: string,
    interval: number,
    now: Date,
  ) {
    return tenant(this.db, user, async (tx) => {
      const [consumed] = await tx
        .update(drafts)
        .set({ consumedAt: now })
        .where(
          and(
            eq(drafts.id, draft.id),
            eq(drafts.userId, user),
            isNull(drafts.consumedAt),
            gt(drafts.expiresAt, now),
          ),
        )
        .returning();
      if (!consumed)
        throw new Problem(
          409,
          "draft-consumed",
          "Draft no longer available",
          "This draft expired or was already used. Create a fresh draft.",
        );
      if (Date.parse(consumed.envelope.caps.expires_at) <= now.getTime())
        throw new Problem(
          409,
          "expired",
          "Strategy expired",
          "Create a draft with a future expiry.",
        );
      const [instance] = await tx
        .insert(instances)
        .values({
          id: randomUUID(),
          userId: user,
          draftId: draft.id,
          name,
          signature,
          runtime: initialRuntime(consumed.plan, now.getTime()),
          tickIntervalMs: interval,
          createdAt: now,
          updatedAt: now,
          nextTickAt: now,
        })
        .returning();
      if (!instance) throw new Error("Instance insert failed");
      return instance;
    });
  }
  async list(user: string, limit = 50, before?: Date, beforeId?: string) {
    return tenant(this.db, user, (tx) =>
      tx
        .select({ instance: instances, draft: drafts })
        .from(instances)
        .innerJoin(drafts, and(eq(drafts.id, instances.draftId), eq(drafts.userId, user)))
        .where(
          and(
            eq(instances.userId, user),
            before
              ? or(
                  lt(instances.createdAt, before),
                  beforeId
                    ? and(eq(instances.createdAt, before), lt(instances.id, beforeId))
                    : undefined,
                )
              : undefined,
          ),
        )
        .orderBy(desc(instances.createdAt), desc(instances.id))
        .limit(limit),
    );
  }
  async detail(user: string, id: string) {
    return tenant(this.db, user, async (tx) => {
      const [row] = await tx
        .select({ instance: instances, draft: drafts })
        .from(instances)
        .innerJoin(drafts, and(eq(drafts.id, instances.draftId), eq(drafts.userId, user)))
        .where(and(eq(instances.id, id), eq(instances.userId, user)));
      if (!row) throw Problem.notFound();
      return row;
    });
  }
  async locked<T>(
    user: string,
    id: string,
    fn: (tx: Transaction, instance: InstanceRow, draft: DraftRow) => Promise<T>,
  ) {
    return tenant(this.db, user, async (tx) => {
      const [instance] = await tx
        .select()
        .from(instances)
        .where(and(eq(instances.id, id), eq(instances.userId, user)))
        .for("update");
      if (!instance) throw Problem.notFound();
      const [draft] = await tx
        .select()
        .from(drafts)
        .where(and(eq(drafts.id, instance.draftId), eq(drafts.userId, user)));
      if (!draft) throw new Error("Instance has no draft");
      return fn(tx, instance, draft);
    });
  }
  async transition(
    user: string,
    id: string,
    action: "arm" | "pause" | "kill",
    now: Date,
    country?: string,
  ) {
    return this.locked(user, id, async (tx, instance, draft) => {
      if (["halted", "ended"].includes(instance.status)) {
        if (action === "kill") return;
        throw new Problem(
          409,
          "terminal-instance",
          "Strategy has ended",
          "A halted or ended strategy needs a new signed draft.",
        );
      }
      if (action === "arm") {
        if (Date.parse(draft.envelope.caps.expires_at) <= now.getTime())
          throw new Problem(409, "expired", "Strategy expired", "The signed strategy has expired.");
      }
      await tx
        .update(instances)
        .set({
          status: action === "arm" ? "armed" : action === "pause" ? "paused" : "halted",
          haltReason: action === "kill" ? "Stopped by user" : null,
          updatedAt: now,
          nextTickAt: now,
          ...(action === "arm" && country
            ? { eligibleCountry: country, eligibilityExpiresAt: new Date(now.getTime() + 86400000) }
            : {}),
        })
        .where(and(eq(instances.id, id), eq(instances.userId, user)));
    });
  }
  /**
   * The one write that turns automatic buying on or off for an instance.
   *
   * `auto` is only ever set after the API has confirmed, against Privy, that the draft's wallet
   * is delegated to the app's signer. Anything else is manual, and going manual pauses the
   * strategy so a user who withdraws the delegation is not left with an armed rule that can
   * no longer act.
   */
  async setMode(user: string, id: string, mode: "auto" | "manual", now = new Date()) {
    return this.locked(user, id, async (tx, instance) => {
      if (["halted", "ended"].includes(instance.status))
        throw new Problem(
          409,
          "terminal-instance",
          "Strategy has ended",
          "A halted or ended strategy needs a new signed draft.",
        );
      const [updated] = await tx
        .update(instances)
        .set({
          mode,
          ...(mode === "manual" && instance.status === "armed" ? { status: "paused" } : {}),
          updatedAt: now,
        })
        .where(and(eq(instances.id, id), eq(instances.userId, user)))
        .returning();
      if (!updated) throw Problem.notFound();
      return updated;
    });
  }
  async history(
    user: string,
    id: string,
    kind: "evaluations" | "executions",
    limit: number,
    before?: Date,
    beforeId?: string,
  ) {
    await this.detail(user, id);
    return tenant(this.db, user, async (tx) => {
      if (kind === "evaluations")
        return tx
          .select()
          .from(evaluations)
          .where(
            and(
              eq(evaluations.instanceId, id),
              eq(evaluations.userId, user),
              before
                ? or(
                    lt(evaluations.at, before),
                    beforeId
                      ? and(eq(evaluations.at, before), lt(evaluations.id, beforeId))
                      : undefined,
                  )
                : undefined,
            ),
          )
          .orderBy(desc(evaluations.at), desc(evaluations.id))
          .limit(limit);
      return tx
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.instanceId, id),
            eq(executions.userId, user),
            before
              ? or(
                  lt(executions.createdAt, before),
                  beforeId
                    ? and(eq(executions.createdAt, before), lt(executions.id, beforeId))
                    : undefined,
                )
              : undefined,
          ),
        )
        .orderBy(desc(executions.createdAt), desc(executions.id))
        .limit(limit);
    });
  }
}
