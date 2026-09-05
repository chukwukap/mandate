import { randomBytes, randomUUID } from "node:crypto";
import { type Hex, type PermissionPayload, Problem } from "@mandate/contracts";
import type { DraftRow, PermissionRow } from "@mandate/database";
import { approvalCall, permissionHash, permissionJson, USDC } from "@mandate/evm";
import { type Plan, units } from "@mandate/strategy";

// SpendPermissionManager packs allowance as uint160 and period/start/end as uint48.
// viem would throw an opaque encoding error on overflow; these bounds turn that into a
// deliberate 409 the client can act on.
export const MAX_ALLOWANCE = 2n ** 160n - 1n;
export const MAX_UINT48 = 2 ** 48 - 1;

/**
 * The exact shape inserted into mandate_v2.permissions. Structurally assignable to
 * drizzle's `permissions.$inferInsert`; declared here so the domain core does not have to
 * import the schema namespace as a value.
 */
export type PreparedPermission = {
  id: string;
  userId: string;
  instanceId: string;
  token: string;
  payload: PermissionPayload;
  hash: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The only place a permission `end` is ever derived. Floor, never round or ceil: the worker
 * (apps/worker/src/chain.ts) refuses to execute when `p.end * 1000 > Date.parse(caps.expires_at)`.
 * An expiry that is not a whole second — every ISO timestamp the API produces carries
 * milliseconds — would be pushed up to 999ms past the signed cap by Math.ceil, and every
 * execution would then fail with a bare "Permission mismatch" *after* the user has signed the
 * permission and paid gas for the onchain approval.
 */
export function permissionEnd(expiresAt: string): number {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms))
    throw new Problem(
      409,
      "expired",
      "Strategy expired",
      "The signed strategy has no usable expiry. Create a fresh strategy.",
    );
  return Math.floor(ms / 1000);
}

/**
 * True when any transition in the plan can emit a sell order. Automatic sells need per-asset
 * (equity token) spend authority, which this API does not issue: a USDC SpendPermission only
 * lets the spender pull the quote asset. Signing one for a sell plan would produce a permission
 * that verifies, activates, and then fails at execution time.
 */
export function requiresSellAuthority(plan: Plan): boolean {
  return plan.machines.some((machine) =>
    machine.states.some((state) =>
      state.transitions.some((transition) =>
        transition.actions.some((action) => action.action === "order" && action.side === "sell"),
      ),
    ),
  );
}

/**
 * Constructs the permission exactly once, from a single captured `now`.
 *
 * The Rust original built the payload here at prepare time and then rebuilt it at submit time
 * with a fresh `now`. Crossing one second changes `start`, which changes the EIP-712 digest,
 * so the signature the user produced verified against a different struct and an ordinary wallet
 * approval failed with "invalid signature". The row this returns is persisted verbatim by
 * Repository.preparePermission (insert-once under a `for update` lock on the instance) and
 * reloaded verbatim at submit; nothing downstream may reconstruct it. The database enforces the
 * same invariant: the immutable_permission trigger rejects any UPDATE touching a column other
 * than status/signature/updated_at.
 */
export function buildPermissionRow(args: {
  user: string;
  instance: string;
  draft: DraftRow;
  spender: Hex;
  now: Date;
}): PreparedPermission {
  const { user, instance, draft, spender, now } = args;
  const caps = draft.envelope.caps;
  // Envelopes are stored JSON signed under whatever capsSchema was current when the draft was
  // written. capsSchema rejects >= 2^160 today, but a draft written before that rule is not
  // re-validated here, so the bound is re-checked against the value actually being signed.
  const allowance = units(caps.per_period, 6);
  if (allowance <= 0n || allowance > MAX_ALLOWANCE)
    throw new Problem(
      409,
      "allowance-unsupported",
      "Budget cannot be authorized",
      "The per-period budget is outside the range an onchain spending permission can express.",
    );
  const start = Math.floor(now.getTime() / 1000);
  const end = permissionEnd(caps.expires_at);
  if (end <= start)
    throw new Problem(
      409,
      "expired",
      "Strategy expired",
      "The signed strategy has expired. Create a fresh strategy.",
    );
  if (end > MAX_UINT48 || caps.period_secs < 1 || caps.period_secs > MAX_UINT48)
    throw new Problem(
      409,
      "period-unsupported",
      "Schedule cannot be authorized",
      "The strategy period or expiry is outside the range an onchain spending permission can express.",
    );
  const payload: PermissionPayload = {
    account: draft.account as Hex,
    spender,
    token: USDC,
    // Integer USDC base units. The worker recomputes units(caps.per_period, 6) and refuses to
    // execute on any mismatch, so this string is a hard equality, not a display value.
    allowance: allowance.toString(),
    period: caps.period_secs,
    // Anchored at prepare time, never at 0 and never rounded to a boundary: `start` is where
    // SpendPermissionManager begins counting the first period window, and the worker rejects
    // a permission whose start is in the future.
    start,
    end,
    // 32 random bytes. Salt is the only field that distinguishes two otherwise identical
    // permissions onchain, so it must never be derived from the instance or the clock.
    salt: BigInt(`0x${randomBytes(32).toString("hex")}`).toString(),
    extraData: "0x",
  };
  return {
    id: randomUUID(),
    userId: user,
    instanceId: instance,
    // Lowercased for the (instance_id, token) unique index; payload.token stays checksummed
    // because it is part of the signed struct.
    token: USDC.toLowerCase(),
    payload,
    hash: permissionHash(payload),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Wire shape for every permission response. Read by apps/web spending-permission.tsx and by the
 * endpoint table in docs/api/README.md; `typed_data` is the stored payload rendered for
 * viem.signTypedData, never a freshly built one.
 */
export function permissionView(row: PermissionRow) {
  return {
    id: row.id,
    instance: row.instanceId,
    status: row.status,
    typed_data: permissionJson(row.payload),
    hash: row.hash,
    spender: row.payload.spender,
    allowance: row.payload.allowance,
    token: row.payload.token,
    period_secs: row.payload.period,
    expires_at: new Date(row.payload.end * 1000).toISOString(),
    execution_available: false,
    ...(row.signature && row.status === "signed"
      ? { approval_call: approvalCall(row.payload, row.signature as Hex) }
      : {}),
  };
}
