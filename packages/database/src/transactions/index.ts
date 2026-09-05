/**
 * Transactional units of work.
 *
 * `withTransaction` and `withTenant` are the composition points: they own isolation and bounded
 * retry so a repository method does not have to. `units.ts` holds the two writes whose halves
 * must never be separated.
 */

export {
  DEADLOCK_DETECTED,
  IN_FAILED_TRANSACTION,
  isRetryable,
  isUniqueViolation,
  LOCK_NOT_AVAILABLE,
  QUERY_CANCELED,
  RETRYABLE_CODES,
  SERIALIZATION_FAILURE,
  sqlState,
  UNIQUE_VIOLATION,
  WriteConflict,
} from "./errors.js";
export { TENANT_SETTING, withTenant } from "./tenant.js";
export type { Attempt, Executor, IsolationLevel, TransactionOptions } from "./unit.js";
export {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_ATTEMPTS,
  defaultBackoffMs,
  isTransaction,
  withTransaction,
} from "./unit.js";
export type {
  ExecutionLeg,
  ExecutionLegResult,
  ExecutionStatus,
  InstanceMode,
  InstanceStatus,
  PermissionGrant,
  PermissionStatus,
  TransactionLeg,
} from "./units.js";
export {
  NonceReused,
  recordExecutionLeg,
  recordPermissionGrant,
  UNIT_OPTIONS,
  writeExecutionLeg,
  writePermissionGrant,
} from "./units.js";
