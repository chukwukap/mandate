/**
 * Session helpers around Privy access tokens.
 *
 * Privy owns login. Nothing here mints, stores or refreshes a credential — there is no cookie,
 * no nonce, no challenge and no server session store, because a second login system is exactly
 * what ADR 0001 forbids. What lives here is the arithmetic around somebody else's token:
 * how long it has left, when the client should ask Privy for a new one, and how long this
 * process may reuse a verification it has already paid for.
 */

export {
  CachedAuthenticator,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_ENTRIES,
  SessionCache,
} from "./cache.js";
export type { SessionAdvice, SessionOptions, SessionState } from "./session.js";
export {
  CLOCK_SKEW_MS,
  REFRESH_LEAD_MS,
  refreshAt,
  remainingMs,
  sessionAdvice,
  sessionState,
} from "./session.js";
export type { AccessTokenClaims } from "./token.js";
export { readAccessTokenClaims, tokenFingerprint } from "./token.js";
