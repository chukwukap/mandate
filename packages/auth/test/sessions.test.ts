import { describe, expect, test } from "bun:test";
import type { Hex } from "@mandate/contracts";
import type { AuthenticatedUser, Authenticator } from "../src/privy/index.js";
import {
  CachedAuthenticator,
  CLOCK_SKEW_MS,
  readAccessTokenClaims,
  REFRESH_LEAD_MS,
  refreshAt,
  remainingMs,
  SessionCache,
  sessionAdvice,
  sessionState,
  tokenFingerprint,
} from "../src/sessions/index.js";

/**
 * Sessions are arithmetic over somebody else's credential.
 *
 * Nothing in this file signs or verifies a token — `auth.test.ts` covers the boundary that does,
 * with the real Privy SDK. These tests pin the two properties that decide whether the cache is
 * safe: a verification is never reused past the credential's own expiry, and the raw bearer token
 * never comes to rest anywhere in the process.
 */

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0);
const SECONDS = T0 / 1000;

const ALICE: AuthenticatedUser = {
  privyDid: "did:privy:alice",
  sessionId: "session-1",
  wallets: ["0x1111111111111111111111111111111111111111" as Hex],
};
const BOB: AuthenticatedUser = {
  privyDid: "did:privy:bob",
  sessionId: "session-2",
  wallets: [],
};

/** A structurally valid JWT with an arbitrary signature segment. Nothing here signs anything. */
function jwt(payload: Record<string, unknown>, signature = "not-a-real-signature"): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "ES256", typ: "JWT" })}.${segment(payload)}.${signature}`;
}

/** The claims Privy actually mints, in seconds, with the lifetime overridable per test. */
function token(overrides: Record<string, unknown> = {}, signature?: string): string {
  const payload = {
    iss: "privy.io",
    aud: "test-app",
    sub: "did:privy:alice",
    sid: "session-1",
    iat: SECONDS,
    exp: SECONDS + 3600,
    ...overrides,
  };
  return signature === undefined ? jwt(payload) : jwt(payload, signature);
}

const CLAIMS = readAccessTokenClaims(token());
if (!CLAIMS) throw new Error("fixture token must decode");

function clockFrom(start: number) {
  let current = start;
  return {
    now: () => current,
    set(value: number) {
      current = value;
    },
  };
}

class Counting implements Authenticator {
  calls = 0;
  constructor(
    private readonly answer: (authorization: string | undefined) => Promise<AuthenticatedUser>,
  ) {}
  authenticate(authorization: string | undefined): Promise<AuthenticatedUser> {
    this.calls += 1;
    return this.answer(authorization);
  }
}

/** Reaches past the private field on purpose: "the token is not in here" is the assertion. */
function stored(cache: SessionCache): Map<string, unknown> {
  return (cache as unknown as { entries: Map<string, unknown> }).entries;
}

describe("reading claims out of a token", () => {
  test("seconds become milliseconds, because a 1000x error here never expires", () => {
    expect(CLAIMS).toEqual({
      subject: "did:privy:alice",
      sessionId: "session-1",
      issuedAt: T0,
      expiresAt: T0 + 3_600_000,
    });
  });

  test("a token with a garbage signature still decodes: this is a decoder, not a verifier", () => {
    // Pinned so nobody later mistakes this function for a security check and removes the
    // verification that runs before it. Everything it returns is used only to shorten a cache
    // entry or to advise a refresh, both of which are safe under a lying token.
    expect(readAccessTokenClaims(token({}, "AAAA"))?.subject).toBe("did:privy:alice");
    expect(readAccessTokenClaims(token({}, ""))?.subject).toBe("did:privy:alice");
  });

  test("a forged expiry is readable but cannot extend anything it is used for", () => {
    const forged = readAccessTokenClaims(token({ exp: SECONDS + 10 ** 9 }));
    expect(forged?.expiresAt).toBe(T0 + 10 ** 12);
    // The only consumer is the cache, and a longer claimed life still cannot exceed its own
    // maxAge — so the liar buys a 60-second entry for a session they already hold.
    const cache = new SessionCache(60_000, 8, CLOCK_SKEW_MS);
    expect(cache.remember(token({ exp: SECONDS + 10 ** 9 }), ALICE, T0)).toBe(true);
    expect(cache.get(token({ exp: SECONDS + 10 ** 9 }), T0 + 60_001)).toBeUndefined();
  });

  for (const [name, value] of Object.entries({
    empty: "",
    "two segments": "a.b",
    "four segments": "a.b.c.d",
    "empty payload segment": "a..c",
    "payload that is not JSON": jwt_raw("not json at all"),
    "payload that is a JSON array": jwt_raw(JSON.stringify([1, 2])),
    "payload that is a JSON string": jwt_raw(JSON.stringify("hello")),
    "payload that is JSON null": jwt_raw(JSON.stringify(null)),
  })) {
    test(`rejects ${name}`, () => {
      expect(readAccessTokenClaims(value)).toBeUndefined();
    });
  }

  for (const [name, overrides] of Object.entries({
    "a missing subject": { sub: undefined },
    "an empty subject": { sub: "" },
    "a non-string subject": { sub: 7 },
    "a missing session id": { sid: undefined },
    "an empty session id": { sid: "" },
    "a fractional issued-at": { iat: SECONDS + 0.5 },
    "a fractional expiry": { exp: SECONDS + 0.5 },
    "a string expiry": { exp: String(SECONDS + 3600) },
    // JSON.stringify turns Infinity into null, which is exactly the shape the guard must reject:
    // Infinity * 1000 would be a cache entry that never expires.
    "an infinite expiry": { exp: Number.POSITIVE_INFINITY },
    "an expiry at issue time": { exp: SECONDS },
    "an expiry before issue time": { exp: SECONDS - 1 },
  })) {
    test(`rejects ${name}`, () => {
      expect(readAccessTokenClaims(token(overrides))).toBeUndefined();
    });
  }

  test("an oversized credential is refused before it is parsed", () => {
    expect(readAccessTokenClaims(token({}, "s".repeat(20_000)))).toBeUndefined();
  });
});

describe("credential fingerprints", () => {
  test("stable, 256-bit, and one-way", () => {
    const value = token();
    expect(tokenFingerprint(value)).toBe(tokenFingerprint(value));
    expect(tokenFingerprint(value)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenFingerprint(value)).not.toContain(value.slice(0, 16));
  });

  test("two tokens for the same user still fingerprint differently", () => {
    expect(tokenFingerprint(token())).not.toBe(tokenFingerprint(token({ exp: SECONDS + 7200 })));
  });
});

describe("expiry, refresh and clock skew", () => {
  test("remaining time floors at zero rather than going negative", () => {
    expect(remainingMs(CLAIMS, T0)).toBe(3_600_000);
    expect(remainingMs(CLAIMS, T0 + 3_600_000)).toBe(0);
    expect(remainingMs(CLAIMS, T0 + 10 ** 9)).toBe(0);
  });

  test("refresh is due a lead time plus a skew allowance before expiry", () => {
    expect(refreshAt(CLAIMS)).toBe(T0 + 3_600_000 - REFRESH_LEAD_MS - CLOCK_SKEW_MS);
  });

  test("a token shorter than the lead time clamps into its own lifetime", () => {
    const brief = readAccessTokenClaims(token({ exp: SECONDS + 60 }));
    if (!brief) throw new Error("fixture must decode");
    // exp - lead - skew is before the token was even issued. Clamping to issuedAt keeps
    // refresh_after inside the lifetime instead of reporting an instant in 1970.
    expect(refreshAt(brief)).toBe(T0);
    expect(refreshAt(brief)).toBeLessThanOrEqual(brief.expiresAt);
    expect(sessionState(brief, T0)).toBe("refresh_due");
  });

  test("the three states switch exactly on their boundaries", () => {
    const due = refreshAt(CLAIMS);
    expect(sessionState(CLAIMS, due - 1)).toBe("active");
    expect(sessionState(CLAIMS, due)).toBe("refresh_due");
    expect(sessionState(CLAIMS, CLAIMS.expiresAt - 1)).toBe("refresh_due");
    expect(sessionState(CLAIMS, CLAIMS.expiresAt)).toBe("expired");
  });

  test("skew only ever moves refresh earlier; it never buys validity past exp", () => {
    const generous = { clockSkewMs: 30 * 60_000 };
    expect(refreshAt(CLAIMS, generous)).toBeLessThan(refreshAt(CLAIMS));
    // The whole point: an hour of claimed skew still does not make an expired token active.
    expect(sessionState(CLAIMS, CLAIMS.expiresAt, generous)).toBe("expired");
    expect(sessionState(CLAIMS, CLAIMS.expiresAt + 1, generous)).toBe("expired");
  });

  test("advice is expressed as a duration the client can trust against its own clock", () => {
    const advice = sessionAdvice(CLAIMS, T0);
    expect(advice).toEqual({
      state: "active",
      expires_at: new Date(T0 + 3_600_000).toISOString(),
      refresh_after: new Date(refreshAt(CLAIMS)).toISOString(),
      refresh_in_ms: refreshAt(CLAIMS) - T0,
      clock_skew_ms: CLOCK_SKEW_MS,
    });
    // A client whose clock is wrong reads refresh_after wrongly but refresh_in_ms correctly.
    expect(sessionAdvice(CLAIMS, refreshAt(CLAIMS) + 5_000).refresh_in_ms).toBe(0);
    expect(sessionAdvice(CLAIMS, refreshAt(CLAIMS) + 5_000).state).toBe("refresh_due");
  });

  test("advice never names the session it was derived from", () => {
    // /v1/me must not imply the Privy session is still live; a verified token is not proof of it.
    expect(JSON.stringify(sessionAdvice(CLAIMS, T0))).not.toContain("session-1");
  });
});

describe("SessionCache", () => {
  test("a verified identity is served back for the same credential", () => {
    const cache = new SessionCache(60_000, 8, CLOCK_SKEW_MS);
    expect(cache.remember(token(), ALICE, T0)).toBe(true);
    expect(cache.get(token(), T0 + 59_999)).toEqual(ALICE);
    expect(cache.get(token(), T0 + 60_000)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("an entry can never outlive the credential, however long the max age is", () => {
    // The safety property. A one-day maxAge against a token with ten minutes left must still
    // stop serving at ten minutes, minus the skew margin.
    const cache = new SessionCache(86_400_000, 8, CLOCK_SKEW_MS);
    const brief = token({ exp: SECONDS + 600 });
    expect(cache.remember(brief, ALICE, T0)).toBe(true);
    expect(cache.get(brief, T0 + 600_000 - CLOCK_SKEW_MS - 1)).toEqual(ALICE);
    expect(cache.get(brief, T0 + 600_000 - CLOCK_SKEW_MS)).toBeUndefined();
  });

  test("a token already inside its skew margin is not cached at all", () => {
    const cache = new SessionCache(60_000, 8, CLOCK_SKEW_MS);
    const nearly = token({ exp: SECONDS + 30 });
    expect(cache.remember(nearly, ALICE, T0)).toBe(false);
    expect(cache.get(nearly, T0)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("a credential whose claims cannot be read is not cached", () => {
    const cache = new SessionCache(60_000, 8, CLOCK_SKEW_MS);
    expect(cache.remember("not-a-jwt", ALICE, T0)).toBe(false);
    expect(cache.size).toBe(0);
  });

  test("the raw bearer token is never held in memory", () => {
    const cache = new SessionCache(60_000, 8, CLOCK_SKEW_MS);
    const value = token();
    cache.remember(value, ALICE, T0);
    expect([...stored(cache).keys()]).toEqual([tokenFingerprint(value)]);
    // A heap dump of this process yields digests, not a map of live credentials.
    expect(JSON.stringify([...stored(cache).values()])).not.toContain(value);
  });

  test("entries are bounded, and the oldest write is the one evicted", () => {
    const cache = new SessionCache(60_000, 2, CLOCK_SKEW_MS);
    const first = token({ sid: "s1" });
    const second = token({ sid: "s2" });
    const third = token({ sid: "s3" });
    cache.remember(first, ALICE, T0);
    cache.remember(second, ALICE, T0);
    cache.remember(third, ALICE, T0);
    expect(cache.size).toBe(2);
    expect(cache.get(first, T0)).toBeUndefined();
    expect(cache.get(second, T0)).toEqual(ALICE);
    expect(cache.get(third, T0)).toEqual(ALICE);
  });

  test("re-remembering a credential refreshes its position, not just its deadline", () => {
    const cache = new SessionCache(60_000, 2, CLOCK_SKEW_MS);
    const first = token({ sid: "s1" });
    const second = token({ sid: "s2" });
    cache.remember(first, ALICE, T0);
    cache.remember(second, ALICE, T0);
    cache.remember(first, ALICE, T0 + 1_000);
    cache.remember(token({ sid: "s3" }), ALICE, T0 + 1_000);
    // `second` is now the oldest write, so it is the one that goes.
    expect(cache.get(first, T0 + 1_000)).toEqual(ALICE);
    expect(cache.get(second, T0 + 1_000)).toBeUndefined();
  });

  test("invalidation is available per session and per user", () => {
    const cache = new SessionCache(60_000, 16, CLOCK_SKEW_MS);
    cache.remember(token({ sid: "session-1", jti: 1 }), ALICE, T0);
    cache.remember(token({ sid: "session-1", jti: 2 }), ALICE, T0);
    cache.remember(token({ sub: "did:privy:bob", sid: "session-2" }), BOB, T0);
    expect(cache.invalidateSession("session-1")).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.invalidateSubject("did:privy:bob")).toBe(1);
    expect(cache.size).toBe(0);
    expect(cache.invalidateSession("session-1")).toBe(0);
  });

  test("clear drops everything", () => {
    const cache = new SessionCache(60_000, 16, CLOCK_SKEW_MS);
    cache.remember(token(), ALICE, T0);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe("CachedAuthenticator", () => {
  const header = `Bearer ${token()}`;

  test("a verified credential is not re-verified upstream on every request", () => {
    const clock = clockFrom(T0);
    const upstream = new Counting(async () => ALICE);
    const auth = new CachedAuthenticator(upstream, new SessionCache(), clock.now);
    return (async () => {
      expect(await auth.authenticate(header)).toEqual(ALICE);
      expect(await auth.authenticate(header)).toEqual(ALICE);
      expect(await auth.authenticate(header)).toEqual(ALICE);
      expect(upstream.calls).toBe(1);
    })();
  });

  test("a burst of concurrent requests collapses into one upstream round trip", async () => {
    let release: (user: AuthenticatedUser) => void = () => {};
    const gate = new Promise<AuthenticatedUser>((resolve) => {
      release = resolve;
    });
    const upstream = new Counting(() => gate);
    const auth = new CachedAuthenticator(upstream, new SessionCache(), clockFrom(T0).now);
    // Nothing has resolved yet, so none of these can hit the cache — only the in-flight map.
    const burst = [auth.authenticate(header), auth.authenticate(header), auth.authenticate(header)];
    release(ALICE);
    expect(await Promise.all(burst)).toEqual([ALICE, ALICE, ALICE]);
    expect(upstream.calls).toBe(1);
  });

  test("the entry is bounded from after the round trip, not before it", async () => {
    const clock = clockFrom(T0);
    const upstream = new Counting(async () => {
      // Privy took 30 seconds to answer. An entry bounded from before the call would already
      // have burned half its life by the time it was written.
      clock.set(T0 + 30_000);
      return ALICE;
    });
    const auth = new CachedAuthenticator(upstream, new SessionCache(60_000), clock.now);
    await auth.authenticate(header);
    clock.set(T0 + 70_000);
    expect(await auth.authenticate(header)).toEqual(ALICE);
    expect(upstream.calls).toBe(1);
    clock.set(T0 + 91_000);
    await auth.authenticate(header);
    expect(upstream.calls).toBe(2);
  });

  test("a rejection is never cached, and every joined caller sees it", async () => {
    const upstream = new Counting(async () => {
      throw Object.assign(new Error("unauthenticated"), { status: 401 });
    });
    const auth = new CachedAuthenticator(upstream, new SessionCache(), clockFrom(T0).now);
    // A cached 401 would pin a user out for the whole TTL; a cached 503 would outlive the outage.
    await expect(auth.authenticate(header)).rejects.toMatchObject({ status: 401 });
    await expect(auth.authenticate(header)).rejects.toMatchObject({ status: 401 });
    expect(upstream.calls).toBe(2);
  });

  test("a concurrent burst that fails leaves nothing behind to poison the next request", async () => {
    let fail: (reason: unknown) => void = () => {};
    const gate = new Promise<AuthenticatedUser>((_resolve, reject) => {
      fail = reject;
    });
    const upstream = new Counting(() => gate);
    const auth = new CachedAuthenticator(upstream, new SessionCache(), clockFrom(T0).now);
    const burst = [auth.authenticate(header), auth.authenticate(header)];
    fail(Object.assign(new Error("upstream down"), { status: 503 }));
    await expect(Promise.all(burst)).rejects.toMatchObject({ status: 503 });
    expect(upstream.calls).toBe(1);
    // The in-flight entry must have been cleared, or this joins a promise that already rejected.
    await expect(auth.authenticate(header)).rejects.toMatchObject({ status: 503 });
    expect(upstream.calls).toBe(2);
  });

  test("the cache never decides a credential is bad; anything odd goes to the delegate", async () => {
    const upstream = new Counting(async () => ALICE);
    const auth = new CachedAuthenticator(upstream, new SessionCache(), clockFrom(T0).now);
    for (const value of [undefined, "", "Basic abc", "Bearer", "Bearer a b"]) {
      await auth.authenticate(value);
    }
    expect(upstream.calls).toBe(5);
  });

  test("a bearer token whose claims cannot be read is verified every time", async () => {
    const upstream = new Counting(async () => ALICE);
    const auth = new CachedAuthenticator(upstream, new SessionCache(), clockFrom(T0).now);
    await auth.authenticate("Bearer not-a-jwt");
    await auth.authenticate("Bearer not-a-jwt");
    expect(upstream.calls).toBe(2);
  });

  test("two users' credentials never collide in the cache", async () => {
    const clock = clockFrom(T0);
    const bobToken = token({ sub: "did:privy:bob", sid: "session-2" });
    const upstream = new Counting(async (authorization) =>
      authorization === `Bearer ${bobToken}` ? BOB : ALICE,
    );
    const auth = new CachedAuthenticator(upstream, new SessionCache(), clock.now);
    expect(await auth.authenticate(header)).toEqual(ALICE);
    expect(await auth.authenticate(`Bearer ${bobToken}`)).toEqual(BOB);
    expect(await auth.authenticate(header)).toEqual(ALICE);
    expect(upstream.calls).toBe(2);
  });

  test("the cache is reachable so a linked-wallet change can invalidate it", async () => {
    const clock = clockFrom(T0);
    const upstream = new Counting(async () => ALICE);
    const auth = new CachedAuthenticator(upstream, new SessionCache(), clock.now);
    await auth.authenticate(header);
    expect(auth.sessions.invalidateSubject("did:privy:alice")).toBe(1);
    await auth.authenticate(header);
    expect(upstream.calls).toBe(2);
  });
});

/** A JWT whose payload segment is arbitrary bytes rather than a claims object. */
function jwt_raw(payload: string): string {
  return `aGVhZGVy.${Buffer.from(payload).toString("base64url")}.sig`;
}
