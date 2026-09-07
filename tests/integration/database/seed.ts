import { randomBytes, randomUUID } from "node:crypto";
import type { Hex, PermissionPayload } from "../../../packages/contracts/src/index.js";
import type { DraftRow, InstanceRow } from "../../../packages/database/src/index.js";
import { permissionHash } from "../../../packages/evm/src/permissions/index.js";
import {
  type Caps,
  capsSchema,
  type Envelope,
  type Intent,
  type Plan,
  planSchema,
  units,
} from "../../../packages/strategy/src/index.js";
import { assetOf, plainAsset, USDC } from "../../fixtures/chain/index.js";
import { asTenant, type Postgres } from "./harness.js";

/**
 * Row builders for the states an integration test needs to start from.
 *
 * Drafts and instances are created through `Repository`, not through raw INSERTs: consuming a
 * draft under `UPDATE ... WHERE consumed_at IS NULL` is the production claim, and a test that
 * inserted an instance directly would be starting from a state the API cannot actually produce.
 * Permissions, executions and journal rows are written as raw SQL, because their production
 * writers are the routes and the worker — the very things under test in the other two suites.
 *
 * Every amount here is an integer of minor units or a decimal string. There is no float anywhere
 * in this file, and the asset decimals come from the shared catalogue rather than a literal: every
 * B20 equity is 8 decimals, and an 18 written here would silently misprice by 1e10.
 */

const AAPL = assetOf("AAPLc");
export const AAPL_ASSET = plainAsset(AAPL);
export const QUOTE_DECIMALS = 6;

/** A wallet address for a seeded tenant. Lowercased: `draft_account_valid` requires it. */
export function account(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

/**
 * One rule: buy 10 USDC of AAPLc whenever the oracle prints under 300.
 *
 * Kept minimal on purpose. These suites are about the database and the HTTP pipeline; the
 * evaluator's own behaviour is covered exhaustively in `packages/strategy/test`.
 */
export const BUY_PLAN: Plan = planSchema.parse({
  params: [],
  nodes: [
    {
      id: "cheap",
      op: "lt",
      args: [
        { kind: "feed", feed: "oracle:AAPLc" },
        { kind: "const", value: "300" },
      ],
    },
  ],
  machines: [
    {
      id: "buy",
      scope: "portfolio",
      initial: "watch",
      states: [
        {
          id: "watch",
          transitions: [
            {
              when: "cheap",
              fires: "on_edge",
              to: "watch",
              actions: [
                { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "10" } },
              ],
            },
          ],
        },
      ],
    },
  ],
});

/** The same plan with a sell leg, which no USDC spend permission can authorise. */
export const SELL_PLAN: Plan = planSchema.parse({
  params: [],
  nodes: [
    {
      id: "rich",
      op: "gt",
      args: [
        { kind: "feed", feed: "oracle:AAPLc" },
        { kind: "const", value: "300" },
      ],
    },
  ],
  machines: [
    {
      id: "exit",
      scope: "portfolio",
      initial: "hold",
      states: [
        {
          id: "hold",
          transitions: [
            {
              when: "rich",
              fires: "on_edge",
              to: "hold",
              actions: [
                { action: "order", asset: 0, side: "sell", size: { unit: "base", value: "1" } },
              ],
            },
          ],
        },
      ],
    },
  ],
});

export function caps(overrides: Partial<Caps> = {}): Caps {
  return capsSchema.parse({
    lifetime: "100",
    per_order: "10",
    per_period: "20",
    period_secs: 86400,
    max_orders_per_period: 2,
    cooldown_secs: 60,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    slippage_bps: 50,
    ...overrides,
  });
}

export function envelopeOf(caps: Caps): Envelope {
  return { version: "mandate/2", caps, assets: [AAPL_ASSET], quote: USDC, venue: "aerodrome" };
}

export type DraftSeed = {
  readonly id: string;
  readonly artifactId: string;
  readonly account: string;
  readonly confirmMessage: string;
  readonly envelope: Envelope;
};

export async function seedDraft(
  pg: Postgres,
  userId: string,
  options: {
    account?: string;
    mode?: "manual" | "auto";
    plan?: Plan;
    caps?: Caps;
    createdAt?: Date;
    expiresAt?: Date;
  } = {},
): Promise<DraftSeed> {
  const now = options.createdAt ?? new Date();
  const owner = (options.account ?? account()).toLowerCase();
  const envelope = envelopeOf(options.caps ?? caps());
  const artifactId = randomBytes(32).toString("hex");
  const id = randomUUID();
  const confirmMessage = `Mandate strategy authorization\nArtifact: ${artifactId}\nAccount: ${owner}`;
  await pg.repo.saveDraft({
    id,
    userId,
    account: owner,
    artifactId,
    name: "AAPL entry",
    mode: options.mode ?? "manual",
    plan: options.plan ?? BUY_PLAN,
    envelope,
    reading: "Structured plan supplied by the user.",
    renderText: "Buy 10 USDC of AAPLc when it trades under 300.",
    renderHash: randomBytes(32).toString("hex"),
    confirmMessage,
    createdAt: now,
    // Thirty minutes, the same window `POST /v1/strategies/draft` grants.
    expiresAt: options.expiresAt ?? new Date(now.getTime() + 1_800_000),
  });
  return { id, artifactId, account: owner, confirmMessage, envelope };
}

export type InstanceSeed = DraftSeed & { readonly instance: InstanceRow; readonly draft: DraftRow };

export async function seedInstance(
  pg: Postgres,
  userId: string,
  options: Parameters<typeof seedDraft>[2] = {},
): Promise<InstanceSeed> {
  const seed = await seedDraft(pg, userId, options);
  const draft = await pg.repo.draft(userId, seed.artifactId);
  if (!draft) throw new Error("seeded draft is not readable by its own tenant");
  const instance = await pg.repo.createInstance(
    userId,
    draft,
    `0x${randomBytes(65).toString("hex")}`,
    draft.name,
    12_000,
    new Date(),
  );
  return { ...seed, instance, draft };
}

/** Moves a seeded instance straight to a state, bypassing the routes that normally guard it. */
export async function forceInstance(
  pg: Postgres,
  userId: string,
  instanceId: string,
  patch: { status?: string; mode?: string; eligibleCountry?: string; eligibilityMs?: number },
): Promise<void> {
  await asTenant(pg, userId, (query) =>
    query(
      `update mandate_v2.instances
         set status = coalesce($3, status),
             mode = coalesce($4, mode),
             eligible_country = coalesce($5, eligible_country),
             eligibility_expires_at = coalesce($6, eligibility_expires_at),
             updated_at = now()
       where id = $1 and user_id = $2`,
      [
        instanceId,
        userId,
        patch.status ?? null,
        patch.mode ?? null,
        patch.eligibleCountry ?? null,
        patch.eligibilityMs ? new Date(Date.now() + patch.eligibilityMs) : null,
      ],
    ),
  );
}

export type PermissionSeed = {
  readonly id: string;
  readonly hash: Hex;
  readonly payload: PermissionPayload;
};

/**
 * A spend permission for a seeded instance.
 *
 * `hash` is computed with the production `permissionHash`, never invented: the funding gate
 * recomputes it from the payload and refuses on a mismatch, so a fixture that made one up would
 * make every permission look tampered with.
 */
export async function seedPermission(
  pg: Postgres,
  userId: string,
  seed: InstanceSeed,
  options: {
    status?: "prepared" | "signed" | "active" | "revoked" | "expired";
    spender?: string;
    allowance?: string;
    start?: number;
    end?: number;
    signature?: string | null;
  } = {},
): Promise<PermissionSeed> {
  const caps = seed.envelope.caps;
  const status = options.status ?? "active";
  const payload: PermissionPayload = {
    account: seed.account as Hex,
    spender: (options.spender ?? `0x${"22".repeat(20)}`) as Hex,
    token: USDC,
    allowance: options.allowance ?? units(caps.per_period, QUOTE_DECIMALS).toString(),
    period: caps.period_secs,
    start: options.start ?? Math.floor(Date.now() / 1000) - 60,
    end: options.end ?? Math.floor(Date.parse(caps.expires_at) / 1000),
    salt: BigInt(`0x${randomBytes(32).toString("hex")}`).toString(),
    extraData: "0x",
  };
  const id = randomUUID();
  const hash = permissionHash(payload);
  const signature =
    options.signature === null
      ? null
      : (options.signature ??
        (["signed", "active"].includes(status) ? `0x${"ab".repeat(65)}` : null));
  await asTenant(pg, userId, (query) =>
    query(
      `insert into mandate_v2.permissions
         (id, user_id, instance_id, token, payload, hash, status, signature, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())`,
      [
        id,
        userId,
        seed.instance.id,
        USDC.toLowerCase(),
        JSON.stringify(payload),
        hash,
        status,
        signature,
      ],
    ),
  );
  return { id, hash, payload };
}

export type ExecutionSeed = { readonly id: string; readonly intent: Intent };

/** An admitted buy order, exactly as `Admission.run` writes one. */
export async function seedExecution(
  pg: Postgres,
  userId: string,
  seed: InstanceSeed,
  options: {
    status?: string;
    stage?: string;
    amountUsdc?: string;
    createdAt?: Date;
  } = {},
): Promise<ExecutionSeed> {
  const amount = options.amountUsdc ?? "10";
  const intent: Intent = { asset: 0, side: "buy", amount, fireKey: "buy:watch:cheap" };
  const id = randomUUID();
  const createdAt = options.createdAt ?? new Date();
  await asTenant(pg, userId, (query) =>
    query(
      `insert into mandate_v2.executions
         (id, user_id, instance_id, status, token_in, token_out, amount_in, intent, stage, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        id,
        userId,
        seed.instance.id,
        options.status ?? "admitted",
        USDC,
        AAPL.token,
        units(amount, QUOTE_DECIMALS).toString(),
        JSON.stringify(intent),
        options.stage ?? "fund",
        createdAt,
      ],
    ),
  );
  return { id, intent };
}

/** An evaluation row stamped at exactly `at`, which is how a detail read pairs it to an order. */
export async function seedEvaluation(
  pg: Postgres,
  userId: string,
  seed: InstanceSeed,
  options: {
    at: Date;
    outcome?: string;
    admitted?: number;
    refused?: string | null;
    inputs?: Record<string, string>;
  },
): Promise<void> {
  await asTenant(pg, userId, (query) =>
    query(
      `insert into mandate_v2.evaluations
         (id, user_id, instance_id, at, outcome, admitted, refused, inputs, notifications)
       values ($1, $2, $3, $4, $5, $6, $7, $8, '[]'::jsonb)`,
      [
        randomUUID(),
        userId,
        seed.instance.id,
        options.at,
        options.outcome ?? "evaluated",
        options.admitted ?? 0,
        options.refused ?? null,
        JSON.stringify(options.inputs ?? { "oracle:AAPLc": "320.08" }),
      ],
    ),
  );
}

/** A 32-byte hash that no other row in the journal can collide with. */
export const txHash = (): string => `0x${randomBytes(32).toString("hex")}`;
