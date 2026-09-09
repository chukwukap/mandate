import {
  executionStatusSchema,
  modeSchema,
  sideSchema,
  statusSchema,
  transactionLegSchema,
  transactionStatusSchema,
  walletKindSchema,
} from "../schemas/primitives.js";
import type {
  ExecutionStatus,
  InstanceStatus,
  Mode,
  Side,
  TransactionLeg,
  TransactionStatus,
  WalletKind,
} from "./primitives.js";

/**
 * The member list of every closed vocabulary, read off the schema that owns it.
 *
 * A union type alone is not usable at runtime — you cannot iterate it, build a `z.enum` from
 * it, or ask whether a string read out of a database column belongs to it — so every consumer
 * that needs the list has been re-typing it. `apps/api/src/modules/executions/view.ts` carries
 * a second copy of all eight execution statuses and derives its own `ExecutionStatus` from it;
 * `apps/api/src/modules/instances/lifecycle.ts` and `apps/worker/src/jobs/execute-intent.ts`
 * each carry their own terminal-status array. Those copies are the drift risk: migration 0004
 * added `recovery_required` to the database CHECK, and a copy that had not learned it would
 * have silently excluded a real row from a status filter.
 *
 * Deriving the list from the schema makes that impossible. Adding a member to
 * ../schemas/primitives.ts adds it here, and `satisfies`/exhaustiveness checks in the domain
 * files below turn a forgotten case into a compile error rather than a wrong answer.
 */

/**
 * The schema's members as a frozen, read-only copy.
 *
 * Copied, not aliased: zod's `.options` is the validator's own array, and handing it out
 * unfrozen would let one careless `sort()` at a call site reorder — or a `push` corrupt — the
 * rule every request in the process is parsed against.
 */
function members<T extends string>(schema: { readonly options: readonly T[] }): readonly T[] {
  return Object.freeze([...schema.options]);
}

export const MODES: readonly Mode[] = members(modeSchema);
export const INSTANCE_STATUSES: readonly InstanceStatus[] = members(statusSchema);
export const SIDES: readonly Side[] = members(sideSchema);
export const WALLET_KINDS: readonly WalletKind[] = members(walletKindSchema);
export const EXECUTION_STATUSES: readonly ExecutionStatus[] = members(executionStatusSchema);
export const TRANSACTION_LEGS: readonly TransactionLeg[] = members(transactionLegSchema);
export const TRANSACTION_STATUSES: readonly TransactionStatus[] = members(transactionStatusSchema);

/**
 * Membership test for a string of unknown provenance — a query parameter, a legacy row, a
 * value from an older writer.
 *
 * Every one of these vocabularies is also a database CHECK, so a stored value is constrained;
 * but `ExecutionRow.status` is typed `string` by drizzle regardless, and casting it to the
 * union is how a value the CHECK was later widened to allow gets treated as one of the cases
 * this build knows about. Narrowing through a real test costs one array scan over at most
 * eight entries.
 */
function isMember<T extends string>(list: readonly T[], value: string): value is T {
  return (list as readonly string[]).includes(value);
}

export const isMode = (value: string): value is Mode => isMember(MODES, value);
export const isInstanceStatus = (value: string): value is InstanceStatus =>
  isMember(INSTANCE_STATUSES, value);
export const isSide = (value: string): value is Side => isMember(SIDES, value);
export const isWalletKind = (value: string): value is WalletKind => isMember(WALLET_KINDS, value);
export const isExecutionStatus = (value: string): value is ExecutionStatus =>
  isMember(EXECUTION_STATUSES, value);
export const isTransactionLeg = (value: string): value is TransactionLeg =>
  isMember(TRANSACTION_LEGS, value);
export const isTransactionStatus = (value: string): value is TransactionStatus =>
  isMember(TRANSACTION_STATUSES, value);
