import { createHash } from "node:crypto";

/**
 * The claims this package reads out of a Privy access token *after* somebody else has verified
 * it. Times are unix milliseconds, because everything else in the codebase measures in ms and
 * the seconds/ms mix-up in an expiry check is a 1000x error in the direction of "never expires".
 */
export type AccessTokenClaims = {
  /** `sub` — the Privy DID. */
  readonly subject: string;
  /** `sid` — the Privy session this token was minted for. */
  readonly sessionId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
};

/** Matches `PrivyAuthenticator`'s ceiling so the two agree on what is even worth parsing. */
const MAX_TOKEN_LENGTH = 16_384;

/**
 * Read a token's claims WITHOUT verifying it.
 *
 * This is a decoder, not a verifier, and the distinction is the whole reason the function is
 * named the way it is. Anyone can mint a JWT that says `exp` is a year from now; nothing here
 * checks a signature, an issuer or an audience. ADR 0001 is explicit that "decoding a token
 * without verification is insufficient", and this function is not an exception to that — it is
 * only ever called on the far side of `PrivyAuthenticator.authenticate`, which has already done
 * the cryptography.
 *
 * What the claims are then used for is deliberately narrow: shortening our own cache lifetime,
 * and telling the client when to refresh. Both are safe under a lying token, because a forged
 * `exp` cannot make an unverified token verify — the worst a liar achieves is a shorter cache
 * entry for a session they already hold, or refresh advice only they will read.
 *
 * Returns undefined rather than throwing for anything malformed. A caller that cannot read the
 * claims must fall back to not caching, which is what every caller here does.
 */
export function readAccessTokenClaims(token: string): AccessTokenClaims | undefined {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return undefined;
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) return undefined;
  let claims: unknown;
  try {
    // `base64url` rejects nothing, so a payload that is not JSON is caught by the parse, and a
    // payload that is JSON but not an object is caught below.
    claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof claims !== "object" || claims === null) return undefined;
  const { sub, sid, iat, exp } = claims as Record<string, unknown>;
  if (typeof sub !== "string" || typeof sid !== "string" || !sub || !sid) return undefined;
  // Seconds, per RFC 7519. Non-integers, NaN and Infinity are all rejected rather than coerced:
  // `Infinity * 1000` is a cache entry that never expires.
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return undefined;
  const issuedAt = (iat as number) * 1000;
  const expiresAt = (exp as number) * 1000;
  // A token whose lifetime is empty or negative is not a token we can reason about at all.
  if (expiresAt <= issuedAt) return undefined;
  return { subject: sub, sessionId: sid, issuedAt, expiresAt };
}

/**
 * A stable, non-reversible handle for a bearer credential.
 *
 * The cache is keyed on this rather than on the token so that the process never holds a usable
 * credential in a long-lived structure. A heap dump, a core file or a debugger attached to a
 * running API then yields digests instead of a map of live bearer tokens for every signed-in
 * user, and the same value is safe to put in a log line or a metric label.
 *
 * Plain SHA-256 with no key is sufficient here because the input is a signed JWT with well over
 * 128 bits of entropy in its signature segment — there is no dictionary to attack. Do not reuse
 * this shape for anything low-entropy.
 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
