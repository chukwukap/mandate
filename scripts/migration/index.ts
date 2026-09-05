/**
 * The Rust-to-`mandate_v2` migration tool.
 *
 * `run.ts` is the command line; this is the library it is built from, exported so the pieces
 * can be driven from a test or a one-off script without going through argv. Nothing here is
 * imported by the API or the worker, and nothing here should be: this is a tool an operator
 * runs during a cutover, not a code path the product depends on.
 *
 * The shape of a migration is: read the legacy database (`legacy`), decide who each user is
 * here (`identity`), translate what can be translated and refuse the rest (`translate`,
 * `catalogue`, `values`), assemble the whole intent (`plan`), print it (`report`), write it in
 * one transaction while journalling every row (`apply`, `journal`), and be able to take it all
 * back out again (`rollback`).
 */

export { applyMigration, targetDirectory } from "./apply.js";
export type { ApplyOptions, ApplyResult } from "./apply.js";
export { BASE_CAIP2, resolveAsset, translateFeed } from "./catalogue.js";
export { openSession, sameDatabase } from "./client.js";
export type { Session } from "./client.js";
export { LINK_FILE_VERSION, loadLinkFile, parseLinkFile, resolveAccount, resolveIdentity } from "./identity.js";
export type { IdentityLink, LinkTable, ResolvedIdentity } from "./identity.js";
export { collect, issue, note, Refused } from "./issues.js";
export type { Issue, IssueCode, Note, NoteCode, Substitution } from "./issues.js";
export {
  closeRun,
  ensureJournal,
  JOURNAL_SCHEMA,
  JOURNAL_VERSION,
  journalPresent,
  listRuns,
  lockRun,
  markRemoved,
  markRetained,
  readImports,
  recordImports,
  recordRun,
} from "./journal.js";
export type { ImportedRow, JournalRun, RunStatus } from "./journal.js";
export { openLegacySource } from "./legacy.js";
export type {
  LegacyActivity,
  LegacyPermission,
  LegacySource,
  LegacyUser,
  LegacyWallet,
} from "./legacy.js";
export { planMigration, planTotals } from "./plan.js";
export type {
  MigrationPlan,
  PermissionNotice,
  PlanOptions,
  PlannedDraft,
  PlannedUser,
  TargetDirectory,
} from "./plan.js";
export { applyReport, planDocument, planReport, rollbackReport } from "./report.js";
export { rollbackMigration } from "./rollback.js";
export type { Retention, RollbackOptions, RollbackResult } from "./rollback.js";
export { asTenant, makeSessionReadOnly, one, widenStatementTimeout, withTransaction } from "./sql.js";
export type { SqlClient } from "./sql.js";
export { translateStrategy } from "./translate.js";
export type { DraftRow, LegacyEnvelope, LegacyStrategy, TranslateOptions, TranslatedDraft } from "./translate.js";
export {
  address,
  deterministicUuid,
  hex,
  instant,
  integer,
  isoFromUnixSeconds,
  optionalInstant,
  rawAmount,
  text,
} from "./values.js";
