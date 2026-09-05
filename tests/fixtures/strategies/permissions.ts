import type {
  Hex,
  PermissionCheck,
  PermissionPayload,
} from "../../../packages/contracts/src/index.js";
import { permissionHash } from "../../../packages/evm/src/permissions/index.js";
import type { PermissionEvidence } from "../../../packages/execution/src/admission/permission.js";
import { units } from "../../../packages/strategy/src/evaluation/money.js";
import { ACCOUNTS, USDC } from "../chain/index.js";
import { caps, T0 } from "./envelopes.js";

/**
 * Spend permissions, in the states that actually turn up in production.
 *
 * The funding gate re-derives all of this from first principles rather than trusting the
 * stored row — it recomputes the EIP-712 digest, compares every field against the caps the
 * user signed, and reads approval off the chain — so each fixture below breaks exactly one of
 * those derivations while leaving the rest intact. A row that says "active" while its payload
 * names a different spender, a larger allowance, or a longer life than the review described is
 * the failure this vocabulary exists for, and it must produce a refusal, not an exception.
 */

const NOW_SECS = Math.floor(T0 / 1000);
const HOUR = 3600;
const DAY = 86_400;

/** The per-period cap the standard envelope signs, in USDC minor units. */
export const SIGNED_ALLOWANCE = units(caps().per_period, 6).toString();

export type PermissionFixture = {
  readonly id: string;
  readonly payload: PermissionPayload;
  /** `permissions.status` as the database stores it. */
  readonly status: "prepared" | "signed" | "active" | "revoked" | "expired";
  readonly signature: Hex;
  readonly signatureValid: boolean;
  readonly onchain: PermissionCheck;
  /** SpendPermissionManager.getCurrentPeriod(). `spend` is USDC minor units already pulled. */
  readonly currentPeriod: { readonly start: number; readonly end: number; readonly spend: bigint };
  /**
   * A stored digest that does NOT match the payload. Only the tamper fixture sets it; every
   * other fixture's hash is recomputed, because a stored hash proves only that something once
   * wrote it.
   */
  readonly storedHash?: Hex;
  readonly note: string;
};

const SIGNATURE: Hex = `0x${"cd".repeat(65)}`;

function payload(overrides: Partial<PermissionPayload> = {}): PermissionPayload {
  return {
    account: ACCOUNTS.user,
    spender: ACCOUNTS.spender,
    token: USDC,
    allowance: SIGNED_ALLOWANCE,
    // Must equal caps.period_secs. The onchain window is anchored at `start` while the
    // strategy runtime anchors its own at instance creation, so the two boundaries drift even
    // when the lengths agree — which is why onchain room can run out while the envelope shows
    // headroom, and why a funding refusal here is normal rather than alarming.
    period: DAY,
    start: NOW_SECS - HOUR,
    end: NOW_SECS + 7 * DAY,
    salt: "1",
    extraData: "0x",
    ...overrides,
  };
}

function fixture(params: {
  id: string;
  note: string;
  payload?: Partial<PermissionPayload>;
  status?: PermissionFixture["status"];
  signatureValid?: boolean;
  onchain?: PermissionCheck;
  spend?: bigint;
  storedHash?: Hex;
}): PermissionFixture {
  const p = payload(params.payload);
  return {
    id: params.id,
    payload: p,
    status: params.status ?? "active",
    signature: SIGNATURE,
    signatureValid: params.signatureValid ?? true,
    onchain: params.onchain ?? { approved: true, revoked: false },
    currentPeriod: { start: p.start, end: p.start + p.period, spend: params.spend ?? 0n },
    ...(params.storedHash ? { storedHash: params.storedHash } : {}),
    note: params.note,
  };
}

export const PERMISSIONS: readonly PermissionFixture[] = [
  fixture({
    id: "active",
    note: "Signed, approved onchain, in force, and matching the signed caps in every field.",
  }),
  fixture({
    id: "expired",
    payload: { end: NOW_SECS - 60 },
    status: "expired",
    note: "The grant ran out a minute ago while the strategy is still armed. The mandate believes it can trade; the chain disagrees, and the chain wins.",
  }),
  fixture({
    id: "revoked",
    status: "revoked",
    onchain: { approved: true, revoked: true },
    note: "Revoked by the user. `isApproved` still answers true — approval and revocation are separate flags — so reading only approval would keep spending after a revoke.",
  }),
  fixture({
    id: "not-started",
    payload: { start: NOW_SECS + 600 },
    note: "Prepared with a future start. Nothing is wrong with it except that it is not in force yet.",
  }),
  fixture({
    id: "ending-inside-horizon",
    payload: { end: NOW_SECS + 120 },
    note: "Two minutes of authority left. Fund, approve and swap are three transactions; starting the sequence here strands the user's USDC in the spender wallet with no authority left to move it back.",
  }),
  fixture({
    id: "allowance-mismatch",
    payload: { allowance: units("500", 6).toString() },
    note: "Half the per-period cap the review described. The row says active; the authority it points at is not the one the user agreed to.",
  }),
  fixture({
    id: "wrong-spender",
    payload: { spender: ACCOUNTS.stranger },
    note: "A permission granted to somebody else's key. This process cannot spend it, and must not pretend the order is merely delayed.",
  }),
  fixture({
    id: "hash-mismatch",
    storedHash: `0x${"ee".repeat(32)}`,
    note: "The stored digest does not hash from the stored payload. One of the two was tampered with or written by a different release; either way the row cannot be trusted.",
  }),
  fixture({
    id: "period-exhausted",
    spend: BigInt(SIGNED_ALLOWANCE),
    note: "Approved, in force, and already fully drawn for this onchain period. The envelope counters may still show room, because the two period windows are anchored differently.",
  }),
];

export function permissionOf(id: string): PermissionFixture {
  const fixture = PERMISSIONS.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`No permission fixture ${id}`);
  return fixture;
}

/**
 * The evidence shape the funding gate consumes.
 *
 * The hash is recomputed from the payload unless the fixture deliberately stores a wrong one,
 * so every fixture except `hash-mismatch` is internally consistent and any refusal it produces
 * comes from the field it actually breaks.
 */
export function evidenceOf(fixture: PermissionFixture): PermissionEvidence {
  return {
    status: fixture.status,
    hash: fixture.storedHash ?? permissionHash(fixture.payload),
    payload: fixture.payload,
    signatureValid: fixture.signatureValid,
    onchain: fixture.onchain,
    currentPeriod: fixture.currentPeriod,
  };
}
