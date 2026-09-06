import type { AuthenticatedUser, Authenticator } from "../privy/index.js";
import { CLOCK_SKEW_MS } from "./session.js";
import { type AccessTokenClaims, readAccessTokenClaims, tokenFingerprint } from "./token.js";

/**
 * How long a verified token may be reused without asking Privy again.
 *
 * Sixty seconds, and the number is a policy choice rather than a performance one. Verification
 * is two upstream calls — `verifyAccessToken` plus the linked-accounts read — on every single
 * request, and the frontend polls `/v1/me`. Without a cache a user with three tabs open costs
 * Privy six calls a second at steady state, and a Privy blip becomes a 503 for everybody.
 *
 * The cost of caching is staleness in exactly two places, and both are already true without it:
 *
 * - Revocation. ADR 0001 says plainly that local JWT verification cannot observe a logout, so
 *   the un-cached path is *already* stale until the token's own expiry, which is far longer than
 *   a minute. The cache does not widen that window in any way that matters.
 * - The linked-wallet list. A wallet linked in Privy shows up here up to a minute late. That is
 *   why `invalidateSubject` exists, and why this must never be raised to the token's lifetime:
 *   an hour-long entry would leave a user staring at a wallet picker that does not list the
 *   wallet they just connected.
 */
export const DEFAULT_MAX_AGE_MS = 60_000;

/** Bounded so a token-spraying caller cannot grow the map without limit. */
export const DEFAULT_MAX_ENTRIES = 2_048;

type Entry = {
  readonly user: AuthenticatedUser;
  readonly claims: AccessTokenClaims;
  /** Unix ms after which this entry must not be served. */
  readonly until: number;
};

/**
 * A cache of *verified* identities, keyed by credential fingerprint.
 *
 * Three rules, each of which is load-bearing:
 *
 * 1. The raw token is never stored — only `tokenFingerprint(token)`. See that function.
 * 2. Only successes are cached. A cached 401 would let one bad request pin a user out for the
 *    whole TTL, and a cached 503 would keep reporting an outage after Privy recovered.
 * 3. The entry expires at `min(now + maxAge, exp - skew)`. Taking the earlier of the two is what
 *    stops the cache outliving the credential: a token with forty seconds left gets a
 *    forty-second entry, not a sixty-second one, and the skew subtraction means a clock a minute
 *    out of step still cannot serve a token past its real expiry.
 */
export class SessionCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly maxAgeMs: number = DEFAULT_MAX_AGE_MS,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
    private readonly clockSkewMs: number = CLOCK_SKEW_MS,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(token: string, now: number = Date.now()): AuthenticatedUser | undefined {
    const key = tokenFingerprint(token);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (now >= entry.until) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.user;
  }

  /**
   * Record a verified identity. Returns false when the token could not be bounded and was
   * therefore not cached — an unparseable token, or one already inside its skew margin.
   */
  remember(token: string, user: AuthenticatedUser, now: number = Date.now()): boolean {
    const claims = readAccessTokenClaims(token);
    if (!claims) return false;
    const until = Math.min(now + this.maxAgeMs, claims.expiresAt - this.clockSkewMs);
    if (until <= now) return false;
    const key = tokenFingerprint(token);
    // Delete before set so Map iteration order is write recency. The oldest write is then also
    // the entry closest to expiring, which makes eviction and the TTL agree instead of evicting
    // an entry that had another fifty seconds left.
    this.entries.delete(key);
    this.entries.set(key, { user, claims, until });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return true;
  }

  /**
   * Drop every entry for one Privy session.
   *
   * The scan is over a map bounded by `maxEntries`, so it is cheap and, more importantly,
   * bounded. This is the hook a logout webhook or an admin action would call; it cannot make
   * revocation immediate on its own, because the un-cached path has the same limitation.
   */
  invalidateSession(sessionId: string): number {
    return this.evict((entry) => entry.claims.sessionId === sessionId);
  }

  /** Drop every entry for one Privy DID — use after a linked-wallet change. */
  invalidateSubject(privyDid: string): number {
    return this.evict((entry) => entry.claims.subject === privyDid);
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(match: (entry: Entry) => boolean): number {
    let removed = 0;
    for (const [key, entry] of this.entries)
      if (match(entry)) {
        this.entries.delete(key);
        removed += 1;
      }
    return removed;
  }
}

/**
 * Only used to find the JWT inside the header so its `exp` can be read.
 *
 * Deliberately looser than the pattern `PrivyAuthenticator` enforces: this is not a validation
 * step and must not behave like one. Anything that does not match is passed straight through to
 * the delegate, which rejects it — the cache never decides that a credential is bad.
 */
const BEARER = /^Bearer (\S+)$/i;

/**
 * `Authenticator` with the upstream round trip cached and de-duplicated.
 *
 * Wrapping rather than modifying `PrivyAuthenticator` keeps one property that matters: every
 * decision about whether a credential is valid still happens in exactly one place. This class
 * can only ever repeat an answer the delegate already gave for the identical credential.
 *
 * The in-flight map handles the burst the cache alone does not. On a cold start the frontend
 * fires several requests with the same token at once; without de-duplication each one is a
 * separate pair of Privy calls, and they all miss the cache because none of them has returned
 * yet. Joining the outstanding promise makes that one round trip.
 */
export class CachedAuthenticator implements Authenticator {
  private readonly inflight = new Map<string, Promise<AuthenticatedUser>>();

  constructor(
    private readonly delegate: Authenticator,
    private readonly cache: SessionCache = new SessionCache(),
    private readonly clock: () => number = Date.now,
  ) {}

  async authenticate(authorization: string | undefined): Promise<AuthenticatedUser> {
    const token = authorization?.match(BEARER)?.[1];
    if (!token) return this.delegate.authenticate(authorization);
    const now = this.clock();
    const cached = this.cache.get(token, now);
    if (cached) return cached;

    const key = tokenFingerprint(token);
    const running = this.inflight.get(key);
    if (running) return running;
    const request = this.delegate
      .authenticate(authorization)
      .then((user) => {
        // Read the clock again: the round trip took time, and an entry bounded from before the
        // call would outlive the token by however long Privy took to answer.
        this.cache.remember(token, user, this.clock());
        return user;
      })
      .finally(() => {
        // The in-flight entry must go whatever happened, or it becomes a second cache with no
        // expiry: a settled promise left here is handed to every later caller forever. On a
        // rejection that pins a 401 or a 503 permanently — precisely what the note below says
        // cannot happen — and on success it outlives the TTL the cache is enforcing.
        this.inflight.delete(key);
      });
    // Rejections are never stored. A 401 stays a live decision and a 503 must not outlast the
    // outage that caused it; both simply propagate to every caller joined to this promise.
    this.inflight.set(key, request);
    return request;
  }

  /** Exposed so a route can invalidate on a linked-wallet change. */
  get sessions(): SessionCache {
    return this.cache;
  }
}
