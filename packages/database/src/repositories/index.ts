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
  type PermissionRow,
  permissions,
  users,
} from "../schema/index.js";

export class Repository {
  constructor(public readonly db: Database) {}

  async resolvePrivyUser(privyDid: string) {
    const [user] = await this.db
      .insert(users)
      .values({ id: randomUUID(), privyDid })
      .onConflictDoUpdate({ target: users.privyDid, set: { privyDid } })
      .returning();
    if (!user) throw new Error("User resolution failed");
    return user;
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
        if (instance.mode === "auto") {
          const [grant] = await tx
            .select()
            .from(permissions)
            .where(
              and(
                eq(permissions.instanceId, id),
                eq(permissions.userId, user),
                eq(permissions.status, "active"),
              ),
            );
          if (!grant || grant.payload.end * 1000 <= now.getTime())
            throw new Problem(
              409,
              "permission-required",
              "Permission required",
              "Confirm an active onchain spending permission first.",
            );
        }
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
  async preparePermission(
    user: string,
    id: string,
    build: (draft: DraftRow, instance: InstanceRow) => typeof permissions.$inferInsert,
  ) {
    return this.locked(user, id, async (tx, instance, draft) => {
      if (["halted", "ended"].includes(instance.status))
        throw new Problem(
          409,
          "terminal-instance",
          "Strategy has ended",
          "Cannot authorize a terminal strategy.",
        );
      const [prior] = await tx
        .select()
        .from(permissions)
        .where(and(eq(permissions.instanceId, id), eq(permissions.userId, user)));
      if (prior) return prior;
      const [created] = await tx.insert(permissions).values(build(draft, instance)).returning();
      if (!created) throw new Error("Permission insert failed");
      return created;
    });
  }
  async permission(user: string, id: string) {
    return tenant(this.db, user, async (tx) => {
      const [row] = await tx
        .select()
        .from(permissions)
        .where(and(eq(permissions.instanceId, id), eq(permissions.userId, user)));
      if (!row) throw Problem.notFound();
      return row;
    });
  }
  async saveGrant(user: string, row: PermissionRow, signature: string, now: Date) {
    return this.locked(user, row.instanceId, async (tx, instance) => {
      if (["halted", "ended"].includes(instance.status))
        throw new Problem(
          409,
          "terminal-instance",
          "Strategy has ended",
          "Cannot authorize a terminal strategy.",
        );
      if (row.payload.end * 1000 <= now.getTime())
        throw new Problem(
          409,
          "expired",
          "Permission expired",
          "Create a new strategy with a future expiry.",
        );
      const [saved] = await tx
        .update(permissions)
        .set({ signature, status: "signed", updatedAt: now })
        .where(
          and(
            eq(permissions.id, row.id),
            eq(permissions.userId, user),
            eq(permissions.hash, row.hash),
            eq(permissions.status, "prepared"),
          ),
        )
        .returning();
      if (saved) return saved;
      const [existing] = await tx
        .select()
        .from(permissions)
        .where(and(eq(permissions.id, row.id), eq(permissions.userId, user)));
      if (existing?.signature === signature && ["signed", "active"].includes(existing.status))
        return existing;
      throw new Problem(
        409,
        "permission-state",
        "Permission changed",
        "Refresh the permission before continuing.",
      );
    });
  }
  async setPermissionStatus(
    user: string,
    row: PermissionRow,
    status: "active" | "revoked" | "expired",
    now: Date,
    enableAuto: boolean,
  ) {
    return this.locked(user, row.instanceId, async (tx, instance) => {
      const [current] = await tx
        .select()
        .from(permissions)
        .where(and(eq(permissions.id, row.id), eq(permissions.userId, user)))
        .for("update");
      if (!current || current.hash !== row.hash) throw Problem.notFound();
      if (current.status === "revoked" && status !== "revoked")
        throw new Problem(
          409,
          "permission-revoked",
          "Permission revoked",
          "A revoked permission cannot be reactivated.",
        );
      if (
        status === "active" &&
        (!current.signature || ["halted", "ended"].includes(instance.status))
      )
        throw new Problem(
          409,
          "permission-state",
          "Cannot activate permission",
          "Sign the permission for a non-terminal strategy first.",
        );
      const [updated] = await tx
        .update(permissions)
        .set({ status, updatedAt: now })
        .where(and(eq(permissions.id, row.id), eq(permissions.userId, user)))
        .returning();
      if (status === "active" && enableAuto)
        await tx
          .update(instances)
          .set({ mode: "auto", updatedAt: now })
          .where(and(eq(instances.id, row.instanceId), eq(instances.userId, user)));
      if (status !== "active")
        await tx
          .update(instances)
          .set({
            mode: "manual",
            status: ["halted", "ended"].includes(instance.status) ? instance.status : "paused",
            updatedAt: now,
          })
          .where(and(eq(instances.id, row.instanceId), eq(instances.userId, user)));
      if (!updated) throw new Error("Permission update failed");
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
