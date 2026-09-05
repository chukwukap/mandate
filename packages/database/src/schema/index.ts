import type { PermissionPayload } from "@mandate/contracts";
import type { Envelope, Intent, Plan, Runtime } from "@mandate/strategy";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const namespace = pgSchema("mandate_v2");
const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date", precision: 3 });
const tenantPolicy = (column: AnyPgColumn) =>
  pgPolicy("tenant_isolation", {
    for: "all",
    to: "public",
    using: sql`${column} = nullif(current_setting('mandate.user_id', true), '')::uuid`,
    withCheck: sql`${column} = nullif(current_setting('mandate.user_id', true), '')::uuid`,
  });

// Privy owns login sessions. Application ownership is stable across wallet changes.
export const users = namespace.table(
  "users",
  {
    id: uuid("id").primaryKey(),
    privyDid: text("privy_did").notNull().unique(),
    createdAt: time("created_at").defaultNow().notNull(),
  },
  (t) => [check("privy_did_valid", sql`${t.privyDid} ~ '^did:privy:[A-Za-z0-9]+$'`)],
);
export const drafts = namespace.table(
  "drafts",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    account: text("account").notNull(),
    artifactId: text("artifact_id").notNull().unique(),
    name: text("name").notNull(),
    mode: text("mode").notNull(),
    plan: jsonb("plan").$type<Plan>().notNull(),
    envelope: jsonb("envelope").$type<Envelope>().notNull(),
    reading: text("reading").notNull(),
    renderText: text("render_text").notNull(),
    renderHash: text("render_hash").notNull(),
    confirmMessage: text("confirm_message").notNull(),
    createdAt: time("created_at").notNull(),
    expiresAt: time("expires_at").notNull(),
    consumedAt: time("consumed_at"),
  },
  (t) => [
    unique("draft_owner").on(t.id, t.userId),
    check("draft_account_valid", sql`${t.account} ~ '^0x[0-9a-f]{40}$'`),
    check("draft_mode_valid", sql`${t.mode} in ('manual','auto')`),
    tenantPolicy(t.userId),
  ],
);
export const instances = namespace.table(
  "instances",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    draftId: uuid("draft_id").notNull().unique(),
    name: text("name").notNull(),
    mode: text("mode").default("manual").notNull(),
    status: text("status").default("paused").notNull(),
    haltReason: text("halt_reason"),
    signature: text("signature").notNull(),
    runtime: jsonb("runtime").$type<Runtime>().notNull(),
    tickIntervalMs: integer("tick_interval_ms").notNull().default(12000),
    createdAt: time("created_at").notNull(),
    updatedAt: time("updated_at").notNull(),
    nextTickAt: time("next_tick_at").notNull(),
    lastTickAt: time("last_tick_at"),
    eligibleCountry: text("eligible_country"),
    eligibilityExpiresAt: time("eligibility_expires_at"),
  },
  (t) => [
    unique("instance_owner").on(t.id, t.userId),
    foreignKey({ columns: [t.draftId, t.userId], foreignColumns: [drafts.id, drafts.userId] }),
    check("instance_mode_valid", sql`${t.mode} in ('manual','auto')`),
    check("instance_status_valid", sql`${t.status} in ('armed','paused','halted','ended')`),
    check("tick_interval_valid", sql`${t.tickIntervalMs} between 1000 and 3600000`),
    index("instance_schedule").on(t.status, t.nextTickAt),
    tenantPolicy(t.userId),
  ],
);
export const permissions = namespace.table(
  "permissions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    instanceId: uuid("instance_id").notNull(),
    token: text("token").notNull(),
    payload: jsonb("payload").$type<PermissionPayload>().notNull(),
    hash: text("hash").notNull().unique(),
    status: text("status").notNull().default("prepared"),
    signature: text("signature"),
    createdAt: time("created_at").notNull(),
    updatedAt: time("updated_at").notNull(),
  },
  (t) => [
    unique("permission_instance_token").on(t.instanceId, t.token),
    foreignKey({
      columns: [t.instanceId, t.userId],
      foreignColumns: [instances.id, instances.userId],
    }),
    check(
      "permission_status_valid",
      sql`${t.status} in ('prepared','signed','active','revoked','expired')`,
    ),
    check(
      "permission_has_signature",
      sql`${t.status} not in ('signed','active') or ${t.signature} is not null`,
    ),
    tenantPolicy(t.userId),
  ],
);
export const evaluations = namespace.table(
  "evaluations",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    instanceId: uuid("instance_id").notNull(),
    at: time("at").notNull(),
    outcome: text("outcome").notNull(),
    admitted: integer("admitted").notNull().default(0),
    refused: text("refused"),
    inputs: jsonb("inputs").$type<Record<string, string>>().notNull(),
    notifications: jsonb("notifications").$type<string[]>().notNull().default([]),
  },
  (t) => [
    foreignKey({
      columns: [t.instanceId, t.userId],
      foreignColumns: [instances.id, instances.userId],
    }),
    check("admissions_nonnegative", sql`${t.admitted} >= 0`),
    index("evaluations_time").on(t.instanceId, t.at),
    tenantPolicy(t.userId),
  ],
);
export const executions = namespace.table(
  "executions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    instanceId: uuid("instance_id").notNull(),
    status: text("status").notNull(),
    tokenIn: text("token_in").notNull(),
    tokenOut: text("token_out").notNull(),
    amountIn: text("amount_in").notNull(),
    txHash: text("tx_hash"),
    reason: text("reason"),
    createdAt: time("created_at").notNull(),
    updatedAt: time("updated_at").defaultNow().notNull(),
    intent: jsonb("intent").$type<Intent>(),
    stage: text("stage").default("fund").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.instanceId, t.userId],
      foreignColumns: [instances.id, instances.userId],
    }),
    check(
      "execution_status_valid",
      sql`${t.status} in ('signal','admitted','pending','confirmed','reverted','cancelled','refunded','recovery_required')`,
    ),
    check("execution_amount_valid", sql`${t.amountIn} ~ '^[0-9]+$'`),
    index("executions_time").on(t.instanceId, t.createdAt),
    unique("execution_owner").on(t.id, t.userId),
    tenantPolicy(t.userId),
  ],
);

// Global coordination contains no user data. Session advisory lock elects one worker;
// generation is checked under a row lock in every worker write transaction.
export const workerState = namespace.table("worker_state", {
  id: integer("id").primaryKey(),
  generation: uuid("generation").notNull(),
  heartbeatAt: time("heartbeat_at").notNull(),
  executionAvailable: integer("execution_available").notNull().default(0),
});
export const transactions = namespace.table(
  "transactions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    executionId: uuid("execution_id").notNull(),
    leg: text("leg").notNull(),
    signer: text("signer").notNull(),
    nonce: integer("nonce").notNull(),
    rawTransaction: text("raw_transaction").notNull(),
    hash: text("hash").notNull().unique(),
    status: text("status").notNull().default("signed"),
    evidence: jsonb("evidence").$type<{
      amount: string;
      recipient: string;
      token: string;
      from?: string;
    }>(),
    createdAt: time("created_at").notNull(),
    confirmedAt: time("confirmed_at"),
  },
  (t) => [
    foreignKey({
      columns: [t.executionId, t.userId],
      foreignColumns: [executions.id, executions.userId],
    }),
    unique("execution_leg").on(t.executionId, t.leg),
    unique("signer_nonce").on(t.signer, t.nonce),
    check("transaction_status_valid", sql`${t.status} in ('signed','confirmed','reverted')`),
    check("transaction_nonce_valid", sql`${t.nonce} >= 0`),
    check("transaction_leg_valid", sql`${t.leg} in ('fund','approve','swap','reset','refund')`),
    tenantPolicy(t.userId),
  ],
);

export type DraftRow = typeof drafts.$inferSelect;
export type InstanceRow = typeof instances.$inferSelect;
export type PermissionRow = typeof permissions.$inferSelect;
export type ExecutionRow = typeof executions.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
