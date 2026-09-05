import type { Hex, PermissionStatus, RawUnits, UnixSeconds } from "./primitives.js";

/**
 * The onchain spend authority behind an automatic strategy, and the states it moves through.
 *
 * A permission is the only thing that lets the executor pull USDC from a user's account. Its
 * lifecycle is deliberately not the instance's: an instance can be paused and re-armed many
 * times under one permission, and revoking the permission is the user's unilateral stop — it
 * needs no cooperation from this server at all.
 */

/**
 * The EIP-712 struct SpendPermissionManager hashes, as JSON.
 *
 * Byte-identical to the declaration in src/index.ts, which is the copy currently imported
 * across the API, the worker and packages/evm; the two are structurally identical and mutually
 * assignable, and index.ts should re-export this one.
 *
 * `allowance` and `salt` are strings because they are uint160 and uint256 onchain and JSON has
 * no integer wide enough; clients convert them to bigint at signing time. They are never
 * numbers here — an allowance rounded through a float64 hashes to a different digest, and the
 * signature the user produced then verifies against a struct nobody authorized.
 *
 * The whole payload is written once, at prepare time, and reloaded verbatim at submit. Nothing
 * downstream may reconstruct it: `start` is derived from a captured `now`, so rebuilding the
 * struct one second later changes the digest and an ordinary wallet approval fails with
 * "invalid signature". The database enforces the same invariant with an immutability trigger.
 */
export type PermissionPayload = {
  /** The user's account the allowance is pulled from. */
  account: Hex;
  /** The executor wallet authorized to pull. */
  spender: Hex;
  /** USDC. A spend permission authorizes exactly one token, which is why automatic sells
   * cannot be issued from a USDC permission alone. */
  token: Hex;
  /** uint160, integer USDC base units, per period — not per order and not for the lifetime. */
  allowance: RawUnits;
  /** uint48 seconds. The window the allowance refreshes on. */
  period: UnixSeconds;
  /** uint48 seconds, inclusive. */
  start: UnixSeconds;
  /** uint48 seconds, exclusive. */
  end: UnixSeconds;
  /** uint256 as a decimal string. Makes two otherwise identical permissions distinct digests. */
  salt: string;
  extraData: Hex;
};

/** What the manager contract says about a payload right now. Both flags, never just one. */
export type PermissionCheck = { approved: boolean; revoked: boolean };

/** uint160. SpendPermissionManager packs the allowance into it; above this, encoding reverts. */
export const MAX_ALLOWANCE = 2n ** 160n - 1n;

/**
 * uint48. `period`, `start` and `end` are packed into it.
 *
 * A larger value encodes perfectly well in JSON and reverts onchain, which is the worst place
 * to find out — the user has already signed. Both bounds are checked before a payload is built.
 */
export const MAX_UINT48 = 2 ** 48 - 1;

export type TerminalPermissionStatus = Extract<PermissionStatus, "revoked" | "expired">;

/**
 * Statuses a permission cannot leave.
 *
 * A revoked permission is never reactivated — the repository refuses that transition outright.
 * Revocation is the user's stop button and it must be one-way, or a bug on this side could
 * quietly restore an authority the user withdrew.
 */
export const TERMINAL_PERMISSION_STATUSES: readonly TerminalPermissionStatus[] = Object.freeze([
  "revoked",
  "expired",
]);

/**
 * What this permission can do right now.
 *
 * - `unsigned`  prepared, no signature. The struct exists so its digest is stable; it carries
 *               no authority whatsoever.
 * - `signed`    the user signed, but the approval is not confirmed onchain. Still not
 *               spendable: the executor pulls through the manager contract, and the manager
 *               only honours an approved permission.
 * - `spendable` approved onchain. The single status that authorizes a transfer, and the only
 *               one under which an instance is allowed to be in auto mode — the repository
 *               forces the instance back to manual and pauses it on every other transition.
 * - `terminal`  revoked or expired. Over.
 */
export type PermissionDisposition = "unsigned" | "signed" | "spendable" | "terminal";

export function permissionDisposition(status: PermissionStatus): PermissionDisposition {
  switch (status) {
    case "prepared":
      return "unsigned";
    case "signed":
      return "signed";
    case "active":
      return "spendable";
    case "revoked":
    case "expired":
      return "terminal";
  }
}

/**
 * Takes a `string`: `PermissionRow.status` is a `text` column.
 *
 * Status is necessary but not sufficient for a pull — the window must also be open and the
 * onchain check must still say approved and not revoked. Anything about to move money asks all
 * three, and this answers only the first.
 */
export function isSpendablePermissionStatus(status: string): boolean {
  return status === "active";
}

export type PermissionWindow = "not_started" | "open" | "expired";

/**
 * Where `now` sits in the permission's own validity window.
 *
 * `start` is inclusive and `end` is exclusive, matching the manager contract and matching the
 * repository, which treats `end * 1000 <= now` as expired. The boundary is not cosmetic: the
 * expiry is derived from the signed envelope with a floor, never a ceiling, precisely so a
 * permission can never outlive the strategy it was signed for by even a millisecond.
 *
 * `now` is in seconds, like the payload — passing milliseconds here reports every live
 * permission as expired.
 */
export function permissionWindow(
  payload: Pick<PermissionPayload, "start" | "end">,
  nowSeconds: number,
): PermissionWindow {
  if (nowSeconds < payload.start) return "not_started";
  return nowSeconds >= payload.end ? "expired" : "open";
}
