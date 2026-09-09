/**
 * Transactional units of work.
 *
 * `withTransaction` and `withTenant` are the composition points: they own isolation and bounded
 * retry so a repository method does not have to. `units.ts` holds the write whose halves must
 * never be separated: a journaled leg and the order state that depends on it.
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
  TransactionLeg,
} from "./units.js";
export {
  NonceReused,
  recordExecutionLeg,
  UNIT_OPTIONS,
  writeExecutionLeg,
} from "./units.js";
