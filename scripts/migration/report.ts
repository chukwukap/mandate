import type { ApplyResult } from "./apply.js";
import type { Issue, Note, Substitution } from "./issues.js";
import type { MigrationPlan } from "./plan.js";
import { planTotals } from "./plan.js";
import type { RollbackResult } from "./rollback.js";

/**
 * What an operator reads before deciding to run this, and what they keep afterwards.
 *
 * The report is written for the failure case. A tool that prints "migrated 412 strategies" and
 * nothing else is one that gets run, believed, and then discovered three weeks later to have
 * skipped nineteen users whose wallets were not in the link file. So refusals come before
 * successes, every refusal names the legacy primary key it came from, and every term this tool
 * had to supply is listed — because those are exactly the ways the card the user will sign
 * differs from the one they signed in the Rust deployment.
 *
 * It contains wallet addresses, Privy DIDs and legacy row ids. Those identify people, so the
 * file is not public — but it holds no signature, no token, no key and no connection string,
 * and it must stay that way: this is the artefact most likely to be pasted into a ticket.
 */

/** Enough detail to act, without a per-row wall that stops being read. */
const SAMPLE = 12;

export function planReport(plan: MigrationPlan, toolVersion: string): string {
  const totals = planTotals(plan);
  const lines: string[] = [
    "Mandate migration plan",
    `  tool            ${toolVersion}`,
    `  source          ${plan.source}`,
    `  built           ${plan.builtAt.toISOString()}`,
    `  origin          ${String(plan.options.origin)}`,
    `  slippage        ${String(plan.options.slippage_bps)} bps (substituted into every migrated envelope)`,
    `  run mode        ${String(plan.options.mode)}`,
    `  signing window  ${String(plan.options.signing_window_ms)} ms`,
    `  replacement expiry ${String(plan.options.replacement_expires_at ?? "(none: lapsed authorities are refused)")}`,
    "",
    "Would write",
    `  users to create        ${totals.usersToCreate}`,
    `  users already here     ${totals.usersReused}`,
    `  drafts to insert       ${totals.draftsToInsert}`,
    `  drafts already present ${totals.draftsAlreadyPresent}`,
    "",
    "Would not write",
    `  legacy users seen              ${plan.counts.legacyUsers}`,
    `  confirmed strategy versions    ${plan.counts.legacyStrategies}`,
    `  versions blocked by identity   ${plan.counts.strategiesBlockedByIdentity}`,
    `  refusals                       ${plan.issues.length}`,
  ];
  lines.push("", ...refusalSection(plan.issues));
  lines.push("", ...substitutionSection(plan));
  lines.push("", ...noteSection(plan.notes));
  lines.push("", ...permissionSection(plan));
  lines.push("", ...activitySection(plan));
  lines.push(
    "",
    "Nothing above has been written. Every migrated strategy arrives unsigned: the Rust",
    "confirmation was a signature over a different message, so each user reviews and signs",
    "again before anything can run.",
  );
  return lines.join("\n");
}

export function applyReport(plan: MigrationPlan, result: ApplyResult, runId: string): string {
  return [
    "Mandate migration applied",
    `  run id            ${runId}`,
    `  source            ${plan.source}`,
    `  started           ${result.startedAt.toISOString()}`,
    `  finished          ${result.finishedAt.toISOString()}`,
    `  users created     ${result.usersCreated}`,
    `  users reused      ${result.usersReused}`,
    `  drafts inserted   ${result.draftsInserted}`,
    `  drafts unchanged  ${result.draftsAlreadyPresent}`,
    `  refusals          ${plan.issues.length} (unchanged by applying; see the plan report)`,
    "",
    `Roll this back with:  migrate rollback --run ${runId}`,
    "Drafts a user has already signed are retained by a rollback and listed; everything else",
    "this run wrote is removed.",
  ].join("\n");
}

export function rollbackReport(result: RollbackResult): string {
  const lines = [
    "Mandate migration rolled back",
    `  run id           ${result.runId}`,
    `  status           ${result.status}`,
    `  drafts removed   ${result.draftsRemoved}`,
    `  users removed    ${result.usersRemoved}`,
    `  already gone     ${result.alreadyGone}`,
    `  retained         ${result.retained.length}`,
  ];
  if (result.retained.length > 0) {
    lines.push("", "Retained (deliberately not deleted):");
    for (const row of result.retained.slice(0, SAMPLE))
      lines.push(`  ${row.entity} ${row.rowId} (${row.legacyRef}): ${row.reason}`);
    if (result.retained.length > SAMPLE)
      lines.push(`  ... and ${result.retained.length - SAMPLE} more; the journal holds them all.`);
  }
  return lines.join("\n");
}

function refusalSection(issues: readonly Issue[]): string[] {
  if (issues.length === 0) return ["Refusals: none."];
  const grouped = new Map<string, Issue[]>();
  for (const item of issues) {
    const list = grouped.get(item.code) ?? [];
    list.push(item);
    grouped.set(item.code, list);
  }
  const lines = ["Refusals — work these before the cutover:"];
  for (const [code, list] of [...grouped].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`  ${code} (${list.length})`);
    for (const item of list.slice(0, SAMPLE)) lines.push(`    ${item.subject}: ${item.detail}`);
    if (list.length > SAMPLE) lines.push(`    ... and ${list.length - SAMPLE} more.`);
  }
  return lines;
}

/**
 * Every way a migrated card differs from the one the user originally signed.
 *
 * Counted by field, then the expiry replacements listed individually, because that one changes
 * how long the user's authority lasts and is the substitution somebody will be asked about.
 */
function substitutionSection(plan: MigrationPlan): string[] {
  const counts = new Map<Substitution["field"], number>();
  const expiries: string[] = [];
  for (const draft of plan.drafts) {
    if (draft.alreadyPresent) continue;
    for (const substitution of draft.substitutions) {
      counts.set(substitution.field, (counts.get(substitution.field) ?? 0) + 1);
      if (substitution.field === "caps.expires_at")
        expiries.push(
          `    ${draft.legacy.versionId}: ${substitution.from} -> ${substitution.to} (${draft.row.name})`,
        );
    }
  }
  if (counts.size === 0) return ["Substituted terms: none."];
  const lines = ["Substituted terms — the user will see these on the new card:"];
  for (const [field, count] of counts) lines.push(`  ${field} (${count})`);
  if (expiries.length > 0) {
    lines.push("  replaced expiries:");
    lines.push(...expiries.slice(0, SAMPLE));
    if (expiries.length > SAMPLE) lines.push(`    ... and ${expiries.length - SAMPLE} more.`);
  }
  return lines;
}

function noteSection(notes: readonly Note[]): string[] {
  const counted = new Map<string, number>();
  for (const item of notes) counted.set(item.code, (counted.get(item.code) ?? 0) + 1);
  if (counted.size === 0) return ["Notes: none."];
  const lines = ["Notes:"];
  for (const [code, count] of counted) lines.push(`  ${code} (${count})`);
  const ineligible = notes.filter((item) => item.code === "jurisdiction.ineligible");
  for (const item of ineligible.slice(0, SAMPLE)) lines.push(`    ${item.subject}: ${item.detail}`);
  if (ineligible.length > SAMPLE)
    lines.push(`    ... and ${ineligible.length - SAMPLE} more ineligible users.`);
  return lines;
}

/**
 * The onchain authorities this migration does not touch.
 *
 * Listed in full, however long the list is. Each row is a live allowance over a user's funds,
 * signed to a spender key this deployment does not hold and cannot revoke: nothing here can
 * spend it and nothing here can cancel it, so the only way it ends is a person acting on this
 * list. Truncating it would be truncating a to-do list about other people's money.
 */
function permissionSection(plan: MigrationPlan): string[] {
  if (plan.permissions.length === 0) return ["Live legacy spend permissions: none."];
  const lines = [
    `Live legacy spend permissions (${plan.permissions.length}) — NOT migrated and NOT revocable from here.`,
    "  The Rust deployment's spender still holds these. Have each user revoke from the wallet",
    "  that granted them, or revoke with the legacy operator tooling, before that system is",
    "  decommissioned. A permission whose watcher is gone is an open allowance.",
  ];
  for (const permission of plan.permissions)
    lines.push(
      `  ${permission.status} ${permission.allowance} of ${permission.token} | account ${permission.account} | spender ${permission.spender} | until ${permission.endsAt} | hash ${permission.permissionHash} | legacy user ${permission.legacyUserId}${permission.privyDid ? ` -> ${permission.privyDid}` : " (unlinked)"}`,
    );
  return lines;
}

/**
 * What is being left behind.
 *
 * Execution history does not migrate: submissions, fills and receipts are records of trades
 * made under a different authority, keyed to rows this schema has no home for. Printing the
 * totals is how an operator learns that before a user asks where their history went, rather
 * than after.
 */
function activitySection(plan: MigrationPlan): string[] {
  const totals = plan.activity.reduce(
    (sum, row) => ({
      submissions: sum.submissions + row.submissions,
      confirmed: sum.confirmed + row.confirmed,
      fills: sum.fills + row.fills,
    }),
    { submissions: 0, confirmed: 0, fills: 0 },
  );
  const traders = plan.activity.filter((row) => row.fills > 0).length;
  return [
    "Legacy execution history (NOT migrated — no equivalent authority exists here):",
    `  submissions ${totals.submissions}, confirmed ${totals.confirmed}, fills ${totals.fills}, across ${traders} user(s) who traded.`,
    "  Keep the legacy database readable for as long as those records must be produceable.",
  ];
}

/** The machine-readable form. Same content, for diffing two rehearsals or filing a run. */
export function planDocument(plan: MigrationPlan, toolVersion: string): Record<string, unknown> {
  return {
    tool_version: toolVersion,
    source: plan.source,
    built_at: plan.builtAt.toISOString(),
    options: plan.options,
    totals: planTotals(plan),
    counts: plan.counts,
    users: plan.users,
    drafts: plan.drafts.map((draft) => ({
      id: draft.row.id,
      user_id: draft.row.userId,
      account: draft.row.account,
      name: draft.row.name,
      mode: draft.row.mode,
      artifact_id: draft.row.artifactId,
      render_hash: draft.row.renderHash,
      expires_at: draft.row.expiresAt.toISOString(),
      already_present: draft.alreadyPresent,
      legacy: draft.legacy,
      substitutions: draft.substitutions,
    })),
    issues: plan.issues,
    notes: plan.notes,
    permissions: plan.permissions,
  };
}
