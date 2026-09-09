import type { Asset } from "../../packages/contracts/src/index.js";
import type { LinkTable, ResolvedIdentity } from "./identity.js";
import { resolveAccount, resolveIdentity } from "./identity.js";
import type { Issue, Note } from "./issues.js";
import { collect, issue, note } from "./issues.js";
import type { LegacyActivity, LegacyPermission, LegacySource } from "./legacy.js";
import type { TranslatedDraft } from "./translate.js";
import { translateStrategy } from "./translate.js";

/**
 * Everything the tool intends to do, computed before it does any of it.
 *
 * The plan is the product. `apply` is a loop that writes what the plan says and journals what
 * it wrote; every decision — who a user is, which wallet they spend from, whether a strategy
 * survives translation, what the card will say — is made here, where it can be printed,
 * reviewed and argued with while nothing has been written. An operator who has read a plan
 * has read the migration.
 *
 * Nothing in here touches the target database except through `TargetDirectory`, and nothing
 * in here writes. Running `plan` against production is safe by construction, which is what
 * makes rehearsal something people will actually do.
 */

/** Reads the tool needs against `mandate_v2` while planning. All of them are `select`s. */
export interface TargetDirectory {
  /** Privy DID to existing `users.id`. The join between the two deployments' identities. */
  usersByDid(dids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** Existing `users.id` to its DID, for detecting an id that is already taken by someone else. */
  didsById(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * Draft id to `artifact_id`, for ONE tenant.
   *
   * Tenant-scoped rather than global because `mandate_v2.drafts` forces row-level security:
   * there is no query that sees every user's drafts at once, and impersonating each tenant in
   * turn is not a workaround, it is the only correct way to ask.
   */
  draftsFor(userId: string, ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export type PlanOptions = {
  /** The target deployment's origin. It is inside the text the user signs. */
  readonly origin: string;
  readonly now: Date;
  readonly catalogue: readonly Asset[];
  /** Bound into every migrated envelope; legacy envelopes had no slippage term. */
  readonly slippageBps: number;
  /** How long a migrated review stays signable. */
  readonly signingWindowMs: number;
  /** Replacement expiry for authorities that have already lapsed. Absent means refuse them. */
  readonly expiresAt?: string | undefined;
  readonly mode: "carry" | "manual";
  /** How the operator names the legacy database in the report and journal. Never a URL. */
  readonly source: string;
  /** Legacy `app_user.id`s to migrate. Empty means everyone. */
  readonly onlyUsers?: readonly string[] | undefined;
};

export type PlannedUser = {
  readonly legacyUserId: string;
  readonly userId: string;
  readonly privyDid: string;
  /** True when this run must insert the `users` row. False when the DID already has one. */
  readonly create: boolean;
  readonly account: string | undefined;
};

export type PlannedDraft = TranslatedDraft & {
  readonly legacyUserId: string;
  /** True when a previous run already imported this exact draft. Apply will skip it. */
  readonly alreadyPresent: boolean;
};

/**
 * A spend permission the legacy deployment still believes is live.
 *
 * Carried into the report and nowhere else. It is an ACTION for a human, not data to import:
 * the allowance is signed to the Rust deployment's per-user spender EOA, and nothing here can
 * spend it, revoke it or reproduce it. Leaving it live means an authority over the user's
 * funds outlives the system that was supposed to be watching it.
 */
export type PermissionNotice = {
  readonly legacyId: string;
  readonly legacyUserId: string;
  readonly privyDid: string | undefined;
  readonly account: string;
  readonly spender: string;
  readonly token: string;
  readonly allowance: string;
  readonly endsAt: string;
  readonly status: string;
  readonly permissionHash: string;
};

export type MigrationPlan = {
  readonly source: string;
  readonly builtAt: Date;
  /** Exactly the terms this plan was computed under. Journalled verbatim on apply. */
  readonly options: Record<string, unknown>;
  readonly users: readonly PlannedUser[];
  readonly drafts: readonly PlannedDraft[];
  readonly issues: readonly Issue[];
  readonly notes: readonly Note[];
  readonly permissions: readonly PermissionNotice[];
  readonly activity: readonly LegacyActivity[];
  readonly counts: {
    readonly legacyUsers: number;
    readonly legacyStrategies: number;
    /** Confirmed versions belonging to a user this run refused. Not translated at all. */
    readonly strategiesBlockedByIdentity: number;
  };
};

/**
 * Legacy account states this tool will migrate.
 *
 * `suspended` and `closed` are refused, and that is a deliberate asymmetry with the rest of
 * the tool: those two are not translation failures, they are decisions somebody already made
 * about this account. `mandate_v2` has no suspension concept at all, so importing a suspended
 * user's strategies would quietly re-enable an account an operator disabled, and importing a
 * closed one re-creates data its owner asked to be rid of.
 */
const MIGRATABLE_STATUS = "active";

export async function planMigration(
  deps: {
    readonly legacy: LegacySource;
    readonly target: TargetDirectory;
    readonly links: LinkTable;
  },
  options: PlanOptions,
): Promise<MigrationPlan> {
  const issues: Issue[] = [];
  const notes: Note[] = [];
  const wanted = new Set(options.onlyUsers ?? []);
  const everyone = await deps.legacy.users();
  const users = wanted.size === 0 ? everyone : everyone.filter((user) => wanted.has(user.id));
  for (const id of wanted)
    if (!everyone.some((user) => user.id === id))
      issues.push(
        issue(
          "identity.account-missing",
          `app_user ${id}`,
          "The run was limited to this legacy user id and the legacy database has no such user.",
        ),
      );

  // Every DID the link file knows, resolved in one round trip. The alternative — one lookup
  // per user as we go — turns a 5,000-user migration into 5,000 queries against a database
  // that is also serving live traffic.
  const linkedDids = [...new Set([...deps.links.byWallet.values()].map((link) => link.privyDid))];
  const existingByDid = await deps.target.usersByDid(linkedDids);

  const identities = new Map<string, ResolvedIdentity>();
  for (const user of users) {
    const subject = `app_user ${user.id}`;
    if (user.status !== MIGRATABLE_STATUS) {
      issues.push(
        issue(
          "identity.not-active",
          subject,
          `The legacy account is ${user.status}. Migrating it would recreate the account in a system that has no way to express that state; re-enable it there first if that is what you mean.`,
        ),
      );
      continue;
    }
    const identity = collect(() => resolveIdentity(user, deps.links, existingByDid), issues);
    if (!identity) continue;
    identities.set(user.id, identity);
    if (!user.eligible)
      notes.push(
        note(
          "jurisdiction.ineligible",
          subject,
          `The legacy record puts this user in ${user.jurisdiction}, which the Rust deployment treated as ineligible. Their drafts import, but arming is gated on the country the new deployment observes at the time.`,
        ),
      );
    if (!identity.create)
      notes.push(
        note(
          "identity.reused",
          subject,
          `${identity.privyDid} already has a mandate_v2 account (${identity.userId}); the migrated drafts attach to it rather than creating a second tenancy.`,
        ),
      );
  }

  // A preserved legacy user id that is already taken here by a DIFFERENT identity. Vanishingly
  // unlikely with random uuids and catastrophic if it happens — one user's drafts filed under
  // another user's row — so it is checked rather than assumed.
  const creating = [...identities.values()].filter((identity) => identity.create);
  const takenIds = await deps.target.didsById(creating.map((identity) => identity.userId));
  for (const [legacyId, identity] of identities) {
    const taken = identity.create ? takenIds.get(identity.userId) : undefined;
    if (taken !== undefined && taken !== identity.privyDid) {
      issues.push(
        issue(
          "identity.did-conflict",
          `app_user ${legacyId}`,
          `The legacy user id is already a mandate_v2 user belonging to ${taken}. Migrating would file this user's strategies under someone else's account.`,
        ),
      );
      identities.delete(legacyId);
    }
  }

  const strategies = await deps.legacy.strategies();
  const mine = strategies.filter((strategy) => !wanted.size || wanted.has(strategy.userId));
  const drafts: PlannedDraft[] = [];
  let blocked = 0;
  for (const strategy of mine) {
    const identity = identities.get(strategy.userId);
    if (!identity) {
      // The user was already refused above with a reason. Re-reporting it per strategy would
      // bury the one line the operator has to act on under fifty copies of its consequence.
      blocked += 1;
      continue;
    }
    const subject = `strategy_version ${strategy.versionId}`;
    const account = collect(() => resolveAccount(strategy.account, identity, subject), issues);
    if (!account) continue;
    const translated = collect(
      () =>
        translateStrategy(strategy, {
          origin: options.origin,
          now: options.now,
          catalogue: options.catalogue,
          userId: identity.userId,
          account,
          slippageBps: options.slippageBps,
          signingWindowMs: options.signingWindowMs,
          expiresAt: options.expiresAt,
          mode: options.mode,
        }),
      issues,
    );
    if (translated)
      drafts.push({ ...translated, legacyUserId: strategy.userId, alreadyPresent: false });
  }

  const resolved = await markAlreadyPresent(drafts, deps.target, notes);
  const permissions = await describeLivePermissions(deps.legacy, identities, notes);

  return {
    source: options.source,
    builtAt: options.now,
    options: {
      origin: options.origin,
      slippage_bps: options.slippageBps,
      signing_window_ms: options.signingWindowMs,
      replacement_expires_at: options.expiresAt ?? null,
      mode: options.mode,
      only_users: options.onlyUsers ?? null,
      catalogue: options.catalogue.map((asset) => `${asset.symbol}:${asset.token}`),
    },
    users: [...identities.entries()].map(([legacyUserId, identity]) => ({
      legacyUserId,
      userId: identity.userId,
      privyDid: identity.privyDid,
      create: identity.create,
      account: identity.account,
    })),
    drafts: resolved,
    issues,
    notes,
    permissions,
    activity: await deps.legacy.activity(),
    counts: {
      legacyUsers: users.length,
      legacyStrategies: mine.length,
      strategiesBlockedByIdentity: blocked,
    },
  };
}

/**
 * Mark the drafts a previous run already imported.
 *
 * Draft ids are derived from the legacy version id and the target user id, so a re-run
 * produces the same id for the same strategy. That is what makes the tool safe to run twice
 * — but only if it can say so in advance. Without this, a plan would claim it is about to
 * import 400 drafts and apply would insert nine, and the operator would have no way to tell
 * that from a silent failure.
 *
 * A row whose id matches but whose artifact digest does not is NOT reported here. It is a
 * genuine collision and it is left for `apply`, which refuses the whole run: two different
 * strategies cannot share a draft id, and deciding which one wins is not a decision a
 * rehearsal should be quietly making.
 */
async function markAlreadyPresent(
  drafts: readonly PlannedDraft[],
  target: TargetDirectory,
  notes: Note[],
): Promise<readonly PlannedDraft[]> {
  const byUser = new Map<string, PlannedDraft[]>();
  for (const draft of drafts) {
    const list = byUser.get(draft.row.userId) ?? [];
    list.push(draft);
    byUser.set(draft.row.userId, list);
  }
  const out: PlannedDraft[] = [];
  for (const [userId, list] of byUser) {
    const present = await target.draftsFor(
      userId,
      list.map((draft) => draft.row.id),
    );
    for (const draft of list) {
      const existing = present.get(draft.row.id);
      const same = existing === draft.row.artifactId;
      if (same)
        notes.push(
          note(
            "draft.already-present",
            `strategy_version ${draft.legacy.versionId}`,
            `Draft ${draft.row.id} is already in mandate_v2 with the same artifact; this run will leave it alone.`,
          ),
        );
      out.push({ ...draft, alreadyPresent: same });
    }
  }
  return out;
}

async function describeLivePermissions(
  legacy: LegacySource,
  identities: ReadonlyMap<string, ResolvedIdentity>,
  notes: Note[],
): Promise<readonly PermissionNotice[]> {
  const live = await legacy.livePermissions();
  return live.map((permission: LegacyPermission) => {
    const identity = identities.get(permission.userId);
    notes.push(
      note(
        "permission.live",
        `spend_permission ${permission.id}`,
        `${permission.allowance} of ${permission.token} is authorised to ${permission.spender} until ${permission.endsAt}. This deployment cannot spend or revoke it; the user must revoke it from the wallet that granted it.`,
      ),
    );
    return {
      legacyId: permission.id,
      legacyUserId: permission.userId,
      privyDid: identity?.privyDid,
      account: permission.account,
      spender: permission.spender,
      token: permission.token,
      allowance: permission.allowance,
      endsAt: permission.endsAt,
      status: permission.status,
      permissionHash: permission.permissionHash,
    };
  });
}

/** Everything the plan would write. Used by the report and by `apply`'s own accounting. */
export function planTotals(plan: MigrationPlan) {
  const insertable = plan.drafts.filter((draft) => !draft.alreadyPresent);
  return {
    usersToCreate: plan.users.filter((user) => user.create).length,
    usersReused: plan.users.filter((user) => !user.create).length,
    draftsToInsert: insertable.length,
    draftsAlreadyPresent: plan.drafts.length - insertable.length,
    substitutions: insertable.reduce((total, draft) => total + draft.substitutions.length, 0),
    refusals: plan.issues.length,
  };
}
