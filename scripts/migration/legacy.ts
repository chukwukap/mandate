import { Problem } from "../../packages/contracts/src/index.js";
import type { SqlClient } from "./sql.js";
import { makeSessionReadOnly } from "./sql.js";
import type { LegacyEnvelope, LegacyStrategy } from "./translate.js";
import { address, instant, integer, isoFromUnixSeconds, optionalInstant, rawAmount, text } from "./values.js";

/**
 * The read side: everything this tool knows how to see in the Rust deployment's schema.
 *
 * An interface rather than a class so the planner can be tested against fixtures without a
 * database, and so a rehearsal against a redacted copy is the same code path as the real
 * run. `openLegacySource` is the only implementation that touches SQL.
 */
export interface LegacySource {
  users(): Promise<readonly LegacyUser[]>;
  strategies(): Promise<readonly LegacyStrategy[]>;
  livePermissions(): Promise<readonly LegacyPermission[]>;
  activity(): Promise<readonly LegacyActivity[]>;
}

export type LegacyWallet = {
  /** Lowercase `0x` hex. */
  readonly address: string;
  readonly kind: string;
  /** CAIP-2, e.g. `eip155:8453`. */
  readonly chainId: string;
};

export type LegacyUser = {
  readonly id: string;
  readonly createdAt: Date;
  readonly status: string;
  readonly jurisdiction: string;
  readonly eligible: boolean;
  readonly wallets: readonly LegacyWallet[];
};

/**
 * A spend permission the legacy deployment still believes is live.
 *
 * The signature is deliberately not read. It is a bearer authorisation over the user's funds
 * — anyone holding it can call `approveWithSignature` on the manager — and this deployment
 * cannot use it anyway, because its spender key is derived differently and `spend()` requires
 * `msg.sender == permission.spender`. Copying it into a second database would widen the blast
 * radius of a breach for no benefit whatsoever.
 */
export type LegacyPermission = {
  readonly id: string;
  readonly userId: string;
  readonly chainId: string;
  readonly account: string;
  readonly spender: string;
  readonly token: string;
  /** Whole units, decimal string, at the permission's own recorded token scale. */
  readonly allowance: string;
  readonly periodSecs: number;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: string;
  readonly permissionHash: string;
};

export type LegacyActivity = {
  readonly userId: string;
  readonly submissions: number;
  readonly confirmed: number;
  readonly fills: number;
  readonly lastFillAt: Date | undefined;
};

/**
 * Open a read-only view of the legacy database.
 *
 * `client` must be one session, not a pool — see `SqlClient`. The session is set read only
 * before anything else runs, so this tool is physically incapable of writing to a database
 * that is still serving the Rust deployment during a rehearsal.
 */
export async function openLegacySource(
  client: SqlClient,
  schema = "public",
): Promise<LegacySource> {
  // Interpolated, not parameterised: PostgreSQL has no parameter form for an identifier in
  // `set search_path`. The regex is the whole defence, so it is deliberately narrow.
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
    throw new Problem(
      400,
      "invalid-schema",
      "Invalid legacy schema",
      "The legacy schema name must be a plain lowercase SQL identifier.",
    );
  await makeSessionReadOnly(client);
  await client.query(`set search_path to ${schema}`);
  return {
    users: () => readUsers(client),
    strategies: () => readStrategies(client),
    livePermissions: () => readLivePermissions(client),
    activity: () => readActivity(client),
  };
}

async function readUsers(client: SqlClient): Promise<readonly LegacyUser[]> {
  const { rows } = await client.query<{
    id: string;
    created_at: unknown;
    status: string;
    jurisdiction: string;
    eligible: boolean;
    wallets: unknown;
  }>(
    `select u.id, u.created_at, u.status::text as status, u.jurisdiction, u.eligible,
            coalesce(json_agg(json_build_object('address', encode(w.address, 'hex'),
                                                'kind', w.kind,
                                                'chainId', w.chain_id)
                              order by w.created_at)
                     filter (where w.id is not null), '[]'::json) as wallets
       from app_user u
       left join wallet w on w.user_id = u.id
      group by u.id
      order by u.created_at`,
  );
  return rows.map((row) => ({
    id: text(row.id, "app_user.id"),
    createdAt: instant(row.created_at, "app_user.created_at"),
    status: text(row.status, "app_user.status"),
    jurisdiction: text(row.jurisdiction, "app_user.jurisdiction"),
    eligible: row.eligible === true,
    wallets: parseWallets(row.wallets, row.id),
  }));
}

function parseWallets(value: unknown, userId: string): readonly LegacyWallet[] {
  // `json_agg` arrives already decoded from node-postgres and PGlite alike; a text form is
  // still accepted so a fixture can hand the reader a plain string.
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed))
    throw new Problem(
      422,
      "migration-value",
      "Unreadable wallets",
      `The wallet aggregate for user ${userId} is not an array.`,
    );
  return parsed.map((entry: { address?: unknown; kind?: unknown; chainId?: unknown }) => ({
    address: address(entry.address, "wallet.address"),
    kind: text(entry.kind, "wallet.kind"),
    chainId: text(entry.chainId, "wallet.chain_id"),
  }));
}

type StrategyRow = {
  version_id: string;
  strategy_id: string;
  user_id: string;
  version: unknown;
  created_at: unknown;
  confirmed_at: unknown;
  artifact_id: string;
  schema_version: string;
  name: string;
  plan_json: unknown;
  envelope_id: string;
  spend_token: string;
  spend_decimals: unknown;
  per_order_raw: unknown;
  per_period_raw: unknown;
  lifetime_raw: unknown;
  period_secs: unknown;
  max_orders_per_period: unknown;
  cooldown_secs: unknown;
  expires_at_unix: unknown;
  mode: string | null;
  permission_account: string | null;
};

async function readStrategies(client: SqlClient): Promise<readonly LegacyStrategy[]> {
  // Only confirmed versions. An unconfirmed one is a review the user walked away from, and
  // re-presenting it here would ask them to sign something they already declined.
  //
  // The lateral picks the most recently armed instance, because a version can be armed,
  // stopped and armed again, and the newest arming is the one whose mode and account reflect
  // what the user last chose.
  const { rows } = await client.query<StrategyRow>(
    `select sv.id as version_id, sv.strategy_id, sv.user_id, sv.version, sv.created_at,
            sv.confirmed_at, encode(sv.artifact_id, 'hex') as artifact_id,
            a.schema_version, a.plan_json,
            s.name,
            e.id as envelope_id, encode(e.spend_token, 'hex') as spend_token, e.spend_decimals,
            e.per_order_raw, e.per_period_raw, e.lifetime_raw,
            e.period_secs, e.max_orders_per_period, e.cooldown_secs, e.expires_at_unix,
            live.mode::text as mode,
            encode(sp.account, 'hex') as permission_account
       from strategy_version sv
       join strategy s on s.id = sv.strategy_id
       join artifact a on a.id = sv.artifact_id
       join envelope e on e.id = sv.envelope_id
       left join lateral (
            select i.mode, i.grant_id
              from instance i
             where i.strategy_version_id = sv.id
             order by i.armed_at desc
             limit 1
       ) live on true
       left join spend_permission sp on sp.id = live.grant_id
      where sv.confirmed_at is not null
      order by sv.user_id, s.name, sv.version`,
  );
  const envelopes = await readAllowlists(
    client,
    rows.map((row) => row.envelope_id),
  );
  return rows.map((row) => {
    const lists = envelopes.get(row.envelope_id) ?? { venues: [], assets: [] };
    const spendDecimals = integer(row.spend_decimals, "envelope.spend_decimals");
    const envelope: LegacyEnvelope = {
      id: text(row.envelope_id, "envelope.id"),
      spendToken: address(row.spend_token, "envelope.spend_token"),
      spendDecimals,
      perOrder: rawAmount(row.per_order_raw, spendDecimals, "envelope.per_order_raw"),
      perPeriod: rawAmount(row.per_period_raw, spendDecimals, "envelope.per_period_raw"),
      lifetime: rawAmount(row.lifetime_raw, spendDecimals, "envelope.lifetime_raw"),
      periodSecs: integer(row.period_secs, "envelope.period_secs"),
      maxOrdersPerPeriod: integer(row.max_orders_per_period, "envelope.max_orders_per_period"),
      cooldownSecs: integer(row.cooldown_secs, "envelope.cooldown_secs"),
      expiresAt: isoFromUnixSeconds(row.expires_at_unix, "envelope.expires_at_unix"),
      venues: lists.venues,
      assets: lists.assets,
    };
    return {
      userId: text(row.user_id, "strategy_version.user_id"),
      strategyId: text(row.strategy_id, "strategy_version.strategy_id"),
      versionId: text(row.version_id, "strategy_version.id"),
      version: integer(row.version, "strategy_version.version"),
      name: text(row.name, "strategy.name"),
      artifactId: text(row.artifact_id, "strategy_version.artifact_id"),
      schemaVersion: text(row.schema_version, "artifact.schema_version"),
      planJson: typeof row.plan_json === "string" ? JSON.parse(row.plan_json) : row.plan_json,
      envelope,
      confirmedAt: optionalInstant(row.confirmed_at, "strategy_version.confirmed_at"),
      createdAt: instant(row.created_at, "strategy_version.created_at"),
      mode: row.mode === "auto" ? "auto" : row.mode === "manual" ? "manual" : undefined,
      account:
        row.permission_account === null
          ? undefined
          : address(row.permission_account, "spend_permission.account"),
    };
  });
}

type Allowlists = { venues: string[]; assets: { token: string; decimals: number | undefined }[] };

/**
 * Read every envelope's allowlist, ordered by `idx`.
 *
 * `order by idx` is not cosmetic. The plan grammar names an asset by its position in this
 * list and has no way to name an address, so the row order IS part of the authority — the
 * legacy schema keys on `idx` for the same reason. Reading these unordered would repoint
 * every order in every migrated strategy at whatever token the planner happened to receive
 * first, and nothing downstream would notice.
 */
async function readAllowlists(
  client: SqlClient,
  envelopeIds: readonly string[],
): Promise<Map<string, Allowlists>> {
  const out = new Map<string, Allowlists>();
  if (envelopeIds.length === 0) return out;
  const { rows } = await client.query<{
    envelope_id: string;
    kind: string;
    idx: unknown;
    value: string;
    decimals: unknown;
  }>(
    `select envelope_id, kind, idx, value, decimals
       from allowlist_entry
      where envelope_id = any($1::uuid[])
      order by envelope_id, kind, idx`,
    [[...new Set(envelopeIds)]],
  );
  for (const row of rows) {
    const lists = out.get(row.envelope_id) ?? { venues: [], assets: [] };
    if (row.kind === "venue") lists.venues.push(text(row.value, "allowlist_entry.value"));
    else if (row.kind === "asset")
      lists.assets.push({
        token: address(row.value, "allowlist_entry.value"),
        decimals:
          row.decimals === null || row.decimals === undefined
            ? undefined
            : integer(row.decimals, "allowlist_entry.decimals"),
      });
    out.set(row.envelope_id, lists);
  }
  return out;
}

async function readLivePermissions(client: SqlClient): Promise<readonly LegacyPermission[]> {
  const { rows } = await client.query<{
    id: string;
    user_id: string;
    chain_id: string;
    account: string;
    spender: string;
    token: string;
    token_decimals: unknown;
    allowance_raw: unknown;
    period_secs: unknown;
    start_unix: unknown;
    end_unix: unknown;
    status: string;
    permission_hash: string;
  }>(
    `select sp.id, sp.user_id, sp.chain_id,
            encode(sp.account, 'hex') as account,
            encode(sp.spender, 'hex') as spender,
            encode(sp.token, 'hex') as token,
            sp.token_decimals, sp.allowance_raw, sp.period_secs, sp.start_unix, sp.end_unix,
            sp.status::text as status,
            encode(sp.permission_hash, 'hex') as permission_hash
       from spend_permission sp
      where sp.status in ('pending', 'active')
      order by sp.user_id, sp.signed_at`,
  );
  return rows.map((row) => {
    const decimals = integer(row.token_decimals, "spend_permission.token_decimals");
    return {
      id: text(row.id, "spend_permission.id"),
      userId: text(row.user_id, "spend_permission.user_id"),
      chainId: text(row.chain_id, "spend_permission.chain_id"),
      account: address(row.account, "spend_permission.account"),
      spender: address(row.spender, "spend_permission.spender"),
      token: address(row.token, "spend_permission.token"),
      allowance: rawAmount(row.allowance_raw, decimals, "spend_permission.allowance_raw"),
      periodSecs: integer(row.period_secs, "spend_permission.period_secs"),
      startsAt: isoFromUnixSeconds(row.start_unix, "spend_permission.start_unix"),
      endsAt: isoFromUnixSeconds(row.end_unix, "spend_permission.end_unix"),
      status: text(row.status, "spend_permission.status"),
      permissionHash: `0x${text(row.permission_hash, "spend_permission.permission_hash")}`,
    };
  });
}

async function readActivity(client: SqlClient): Promise<readonly LegacyActivity[]> {
  const { rows } = await client.query<{
    user_id: string;
    submissions: unknown;
    confirmed: unknown;
    fills: unknown;
    last_fill_at: unknown;
  }>(
    `select u.id as user_id,
            (select count(*) from submission s where s.user_id = u.id) as submissions,
            (select count(*) from submission s
              where s.user_id = u.id and s.state = 'confirmed') as confirmed,
            (select count(*) from fill f where f.user_id = u.id) as fills,
            (select max(f.filled_at) from fill f where f.user_id = u.id) as last_fill_at
       from app_user u
      order by u.created_at`,
  );
  return rows.map((row) => ({
    userId: text(row.user_id, "app_user.id"),
    submissions: integer(row.submissions, "submission count"),
    confirmed: integer(row.confirmed, "confirmed submission count"),
    fills: integer(row.fills, "fill count"),
    lastFillAt: optionalInstant(row.last_fill_at, "fill.filled_at"),
  }));
}
