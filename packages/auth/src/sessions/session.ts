import type { AccessTokenClaims } from "./token.js";

/**
 * Tolerance for a disagreement between this server's clock and Privy's.
 *
 * The same 60 seconds `PrivyAuthenticator` already allows on `issued_at`. It is applied here in
 * one direction only — it makes us treat a token as needing refresh *earlier*, never as valid
 * *longer*. Extending validity past `exp` on the strength of "our clock might be fast" is how a
 * skew allowance becomes a way to keep using a revoked credential.
 */
export const CLOCK_SKEW_MS = 60_000;

/**
 * How long before expiry the client should be told to refresh.
 *
 * Two minutes covers the case that actually hurts: a user who opened the review card, read it,
 * and is now waiting on a wallet prompt. Their next request is the strategy submission carrying
 * a signature they cannot cheaply reproduce, and a 401 there costs them the signing round trip.
 */
export const REFRESH_LEAD_MS = 120_000;

export type SessionState =
  /** Comfortably valid. */
  | "active"
  /** Still valid, but the client should refresh now rather than at the next request. */
  | "refresh_due"
  /** Past `exp`. Privy's verifier will already be rejecting it. */
  | "expired";

export type SessionOptions = {
  readonly clockSkewMs?: number | undefined;
  readonly refreshLeadMs?: number | undefined;
};

/** Milliseconds of validity left, never negative. */
export function remainingMs(claims: AccessTokenClaims, now: number): number {
  return Math.max(0, claims.expiresAt - now);
}

/**
 * The instant at which the client should refresh.
 *
 * Both the lead time and the skew allowance are subtracted, and the result is clamped into the
 * token's own lifetime. The clamp matters for short-lived tokens: without it a token minted
 * with a five-minute life would produce a `refresh_after` in the past, and a client that treats
 * that as "refresh now, then retry" would loop against Privy at request rate.
 */
export function refreshAt(claims: AccessTokenClaims, options: SessionOptions = {}): number {
  const lead = options.refreshLeadMs ?? REFRESH_LEAD_MS;
  const skew = options.clockSkewMs ?? CLOCK_SKEW_MS;
  return Math.min(claims.expiresAt, Math.max(claims.issuedAt, claims.expiresAt - lead - skew));
}

export function sessionState(
  claims: AccessTokenClaims,
  now: number,
  options: SessionOptions = {},
): SessionState {
  if (now >= claims.expiresAt) return "expired";
  return now >= refreshAt(claims, options) ? "refresh_due" : "active";
}

/**
 * What a response can tell the client about its own session.
 *
 * Everything here is derived from a token the client already holds, so none of it discloses
 * anything the caller did not bring with them. The session id is deliberately absent for the
 * reason `/v1/me` documents: a verified token is not proof that the Privy session is still
 * live, and no field may imply that it is.
 */
export type SessionAdvice = {
  readonly state: SessionState;
  /** ISO 8601, from the server's clock. */
  readonly expires_at: string;
  readonly refresh_after: string;
  /**
   * The same instant as a duration.
   *
   * This is the field a client should actually use, and it exists because the client's clock is
   * the one thing this server cannot observe. A browser running ten minutes fast reads
   * `refresh_after` as already past and refreshes on every request; one running ten minutes slow
   * never refreshes at all and discovers expiry as a 401 halfway through a signing flow. A
   * relative duration is immune to both, because it is measured against an instant the client
   * itself observes — the moment the response arrived.
   */
  readonly refresh_in_ms: number;
  readonly clock_skew_ms: number;
};

export function sessionAdvice(
  claims: AccessTokenClaims,
  now: number,
  options: SessionOptions = {},
): SessionAdvice {
  const refresh = refreshAt(claims, options);
  return {
    state: sessionState(claims, now, options),
    expires_at: new Date(claims.expiresAt).toISOString(),
    refresh_after: new Date(refresh).toISOString(),
    refresh_in_ms: Math.max(0, refresh - now),
    clock_skew_ms: options.clockSkewMs ?? CLOCK_SKEW_MS,
  };
}
