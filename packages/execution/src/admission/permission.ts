import type { Hex, PermissionCheck, PermissionPayload } from "@mandate/contracts";
import { permissionHash, USDC } from "@mandate/evm";
import type { Caps } from "@mandate/strategy";
import { units, whole } from "@mandate/strategy";
import { QUOTE_DECIMALS } from "./limits.js";
import { type Refusal, refuse } from "./refusal.js";

/**
 * Everything the gate needs to know about the spend permission, gathered by a port.
 *
 * Three of these fields are chain reads and one is a database read, and they are grouped
 * into a single value so the checks below stay pure and testable without a node. The
 * signature itself never reaches a refusal or a log line; only `signatureValid` does.
 */
export type PermissionEvidence = {
  /** `permissions.status` as stored: prepared | signed | active | revoked | expired. */
  readonly status: string;
  /** `permissions.hash` as stored, recomputed and compared rather than trusted. */
  readonly hash: string;
  readonly payload: PermissionPayload;
  /** True when the stored signature verifies against the account. */
  readonly signatureValid: boolean;
  /** SpendPermissionManager.isApproved / isRevoked. */
  readonly onchain: PermissionCheck;
  /**
   * SpendPermissionManager.getCurrentPeriod(). `spend` is in USDC minor units.
   *
   * The contract anchors this window at the permission's `start`, while the strategy
   * runtime anchors its own at instance creation. The two drift, so onchain room can be
   * exhausted while the envelope still shows headroom — this is the read that catches it,
   * and it is the reason a funding refusal here is normal rather than alarming.
   */
  readonly currentPeriod: { readonly start: number; readonly end: number; readonly spend: bigint };
};

export type PermissionCheckInput = {
  readonly evidence: PermissionEvidence | undefined;
  /** The account that signed the strategy, from `drafts.account`. */
  readonly account: string;
  /** The address this process will actually sign with. */
  readonly spender: string;
  readonly caps: Caps;
  /** Order input in USDC minor units. */
  readonly amountIn: bigint;
  /** Unix ms. */
  readonly now: number;
  /**
   * Seconds of authority that must remain after funding.
   *
   * Funding, approval and the swap are three separate transactions. Each waits for
   * confirmations, so ~20s of chain time on Base's 2s blocks, but the worker's poll
   * interval, receipt lookups, and the possibility of falling into the reset/refund path
   * mid-sequence make the real span minutes. If the permission expires between the pull
   * and the swap, the USDC is already sitting in the spender wallet with no authority left
   * to do anything but return it — a refund transaction, a burnt fee, and an order the user
   * watched go nowhere. Five minutes is the margin that makes that outcome rare; it is a
   * policy number and callers may raise it.
   */
  readonly horizonSecs?: number | undefined;
};

const DEFAULT_HORIZON_SECS = 300;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Re-derive the spend permission's validity from first principles.
 *
 * Nothing here trusts `permissions.status`: the hash is recomputed from the payload, every
 * field is compared against the caps the user actually signed, and approval comes from the
 * chain. A row that says "active" while the payload allows a different spender, a larger
 * allowance or a longer life than the review described is the exact failure this catches,
 * and it is a refusal rather than an exception because a wrong row must stop an order, not
 * crash the tick that would have recorded why.
 */
export function checkPermission(input: PermissionCheckInput): Refusal[] {
  const { account, spender, caps, amountIn, now } = input;
  const evidence = input.evidence;
  const refusals: Refusal[] = [];
  if (!evidence)
    return [
      refuse(
        "permission.missing",
        "No spend permission is recorded for this strategy",
        "none",
        "an active permission",
        "permission",
      ),
    ];
  if (evidence.status !== "active" || !evidence.signatureValid)
    refusals.push(
      refuse(
        "permission.inactive",
        "The spend permission is not active",
        evidence.signatureValid ? evidence.status : `${evidence.status}/unverified-signature`,
        "active",
        "status",
      ),
    );

  const p = evidence.payload;
  // Recomputed, not read back. A stored hash proves only that something once wrote it.
  const recomputed: Hex = permissionHash(p);
  if (!same(recomputed, evidence.hash))
    refusals.push(
      refuse(
        "permission.hash_mismatch",
        "The stored permission does not hash to its stored digest",
        recomputed,
        evidence.hash,
        "EIP-712 digest",
      ),
    );
  if (!same(p.account, account))
    refusals.push(
      refuse(
        "permission.account_mismatch",
        "The permission was granted by a different account",
        p.account,
        account,
        "address",
      ),
    );
  if (!same(p.spender, spender))
    refusals.push(
      refuse(
        "permission.spender_mismatch",
        "The permission names a different spender than this process",
        p.spender,
        spender,
        "address",
      ),
    );
  if (!same(p.token, USDC))
    refusals.push(
      refuse(
        "permission.token_mismatch",
        "The permission is not denominated in USDC",
        p.token,
        USDC,
        "token",
      ),
    );
  if (p.period !== caps.period_secs)
    refusals.push(
      refuse(
        "permission.period_mismatch",
        "The onchain period differs from the signed period",
        p.period,
        caps.period_secs,
        "seconds",
      ),
    );
  const signedAllowance = units(caps.per_period, QUOTE_DECIMALS);
  if (p.allowance !== signedAllowance.toString())
    refusals.push(
      refuse(
        "permission.allowance_mismatch",
        "The onchain allowance differs from the signed per-period cap",
        whole(BigInt(p.allowance), QUOTE_DECIMALS),
        whole(signedAllowance, QUOTE_DECIMALS),
        "USDC",
      ),
    );

  const strategyEnd = Date.parse(caps.expires_at);
  if (p.end * 1000 > strategyEnd)
    refusals.push(
      refuse(
        "permission.outlives_strategy",
        "The permission outlives the strategy it was granted for",
        new Date(p.end * 1000).toISOString(),
        caps.expires_at,
        "UTC",
      ),
    );
  const nowSecs = Math.floor(now / 1000);
  if (p.start > nowSecs)
    refusals.push(
      refuse(
        "permission.not_started",
        "The permission is not yet in force",
        new Date(p.start * 1000).toISOString(),
        new Date(now).toISOString(),
        "UTC",
      ),
    );
  if (p.end <= nowSecs)
    refusals.push(
      refuse(
        "permission.expired",
        "The permission has expired",
        new Date(p.end * 1000).toISOString(),
        new Date(now).toISOString(),
        "UTC",
      ),
    );
  else {
    // The binding authority end is whichever runs out first.
    const horizonSecs = input.horizonSecs ?? DEFAULT_HORIZON_SECS;
    const authorityEnd = Math.min(p.end * 1000, strategyEnd);
    const remaining = Math.floor((authorityEnd - now) / 1000);
    if (remaining < horizonSecs)
      refusals.push(
        refuse(
          "permission.horizon",
          "Too little authority remains to fund, approve and swap safely",
          remaining,
          horizonSecs,
          "seconds",
        ),
      );
  }

  if (!evidence.onchain.approved || evidence.onchain.revoked)
    refusals.push(
      refuse(
        "permission.inactive",
        evidence.onchain.revoked
          ? "The permission has been revoked onchain"
          : "The permission is not approved onchain",
        evidence.onchain.revoked ? "revoked" : "not-approved",
        "approved",
        "onchain state",
      ),
    );

  // The one check that is about this order rather than the grant. Onchain spend is the
  // authority that actually pays; the envelope counters are only this server's mirror.
  const allowance = BigInt(p.allowance);
  const wouldSpend = evidence.currentPeriod.spend + amountIn;
  if (wouldSpend > allowance)
    refusals.push(
      refuse(
        "permission.period_allowance",
        "The onchain allowance for the current period cannot cover this order",
        whole(wouldSpend, QUOTE_DECIMALS),
        whole(allowance, QUOTE_DECIMALS),
        "USDC",
      ),
    );

  return refusals;
}
