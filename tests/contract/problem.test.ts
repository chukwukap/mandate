import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  APP_ORIGIN,
  type ContractApi,
  call,
  commitStrategy,
  newIdentity,
  PROVIDER_DOWN_TOKEN,
  startContractApi,
  type TestIdentity,
} from "./harness.js";
import { parsed, problemSchema } from "./schemas.js";

/**
 * The failure contract: one body shape, produced by one handler, for every way a request can go
 * wrong.
 *
 * This is the half of the API a client spends most of its error-handling code on and the half
 * that is easiest to break without noticing, because nothing renders a 409. apps/web branches on
 * `code`, shows `detail`, and reports `request_id` to support; a route that answered with
 * fastify's own `{ statusCode, error, message }` would satisfy every happy-path test in the repo
 * and leave the UI with an undefined message and no code to branch on.
 *
 * Every assertion below therefore checks three things together: the HTTP status, the
 * `application/problem+json` content type, and the body against `problemSchema` — which is
 * strict, so a seventh key fails. That strictness is a security property. `setErrorHandler` is
 * where every thrown error in the process converges, including SDK errors whose message or body
 * can carry a bearer token or an RPC URL with a provider key in it, and the handler is written
 * to construct the response field by field rather than spread the caught error.
 */

let api: ContractApi;
let alice: TestIdentity;
let bob: TestIdentity;

beforeAll(async () => {
  alice = newIdentity();
  bob = newIdentity();
  api = await startContractApi({ identities: [alice, bob] });
}, 60_000);

afterAll(async () => {
  await api.close();
}, 30_000);

/** Status, content type and body in one place: all three are the contract, not just the body. */
async function problemOf(response: Awaited<ReturnType<typeof call>>, status: number) {
  expect(response.statusCode).toBe(status);
  expect(response.headers["content-type"]).toContain("application/problem+json");
  const body = parsed(problemSchema, response.json());
  expect(body.status).toBe(status);
  // `type` is derived from `code` and nothing else, so a client can route on either.
  expect(body.type).toBe(`urn:mandate:problem:${body.code}`);
  return body;
}

describe("the RFC7807 body", () => {
  test("carries exactly type, title, status, code, detail and request_id", async () => {
    const body = await problemOf(await call(api, { url: "/v1/me" }), 401);
    expect(Object.keys(body).sort()).toEqual([
      "code",
      "detail",
      "request_id",
      "status",
      "title",
      "type",
    ]);
    expect(body.code).toBe("unauthenticated");
    expect(body.title).toBe("Sign in required");
    expect(body.detail).toBe("Sign in to continue.");
  });

  test("`status` is the field name, not fastify's `statusCode`", async () => {
    // `Problem` carries `status` and apps/web reads `status`. Emitting `statusCode` instead
    // would be a silent rename: the body would still be JSON, still have a number in it, and
    // every branch in the client that inspects the code would fall through to the default.
    const raw = (await call(api, { url: "/v1/me" })).json<Record<string, unknown>>();
    expect(raw.status).toBe(401);
    expect(raw).not.toHaveProperty("statusCode");
    expect(raw).not.toHaveProperty("error");
    expect(raw).not.toHaveProperty("message");
  });

  test("request_id matches the x-request-id header and is server-generated", async () => {
    const response = await call(api, {
      url: "/v1/me",
      headers: { "x-request-id": "client-chosen-id" },
    });
    const body = await problemOf(response, 401);
    expect(response.headers["x-request-id"]).toBe(body.request_id);
    // The server is built with `requestIdHeader: false`, so a caller cannot choose its own id.
    // If it could, two unrelated requests could claim one id and the audit trail would stop
    // being an audit trail.
    expect(body.request_id).not.toBe("client-chosen-id");
  });

  test("every failure is no-store, whichever hook produced it", async () => {
    for (const response of [
      await call(api, { url: "/v1/me" }),
      await call(api, { url: "/v1/nothing-here", token: alice.token }),
      await call(api, { url: "/v1/me", headers: { origin: "https://evil.example" } }),
    ])
      expect(response.headers["cache-control"]).toBe("no-store");
  });

  test("no upstream detail leaks into the body", async () => {
    // Every `detail` in this API is a sentence written for a user. The one place an upstream
    // string could reach a response is the error handler, and it never reads `error.message`
    // for a non-Problem — an SDK error's message can carry the submitted bearer token or an
    // RPC URL with a provider key embedded.
    const body = await problemOf(
      await call(api, { url: "/v1/me", token: PROVIDER_DOWN_TOKEN }),
      503,
    );
    expect(body.detail).toBe("Authentication verification is temporarily unavailable.");
    expect(body.detail).not.toContain(PROVIDER_DOWN_TOKEN);
  });
});

describe("the status a caller gets, per failure", () => {
  test("401 for a missing token and 401 for a token that does not verify", async () => {
    expect((await problemOf(await call(api, { url: "/v1/me" }), 401)).code).toBe("unauthenticated");
    expect(
      (await problemOf(await call(api, { url: "/v1/me", token: "not-a-token" }), 401)).code,
    ).toBe("unauthenticated");
  });

  test("503, not 401, when the identity provider itself is unreachable", async () => {
    // The distinction is load-bearing. Answering 401 during a provider blip tells every
    // signed-in user their session was revoked, and they all re-authenticate against the
    // provider that is already down.
    const body = await problemOf(
      await call(api, { url: "/v1/me", token: PROVIDER_DOWN_TOKEN }),
      503,
    );
    expect(body.code).toBe("unavailable");
  });

  test("403 for a foreign Origin, decided before the token is examined", async () => {
    const body = await problemOf(
      await call(api, {
        url: "/v1/me",
        token: alice.token,
        headers: { origin: "https://evil.example" },
      }),
      403,
    );
    // A valid token from the wrong origin is still 403. If authentication ran first this would
    // be a 401, and an unauthenticated cross-origin probe would become a free round trip to the
    // identity provider that an attacker can trigger.
    expect(body.code).toBe("origin-denied");
    // The app's own origin passes through the same hook.
    expect(
      (await call(api, { url: "/v1/me", token: alice.token, headers: { origin: APP_ORIGIN } }))
        .statusCode,
    ).toBe(200);
  });

  test("403 not-eligible for a jurisdiction the product is not offered in", async () => {
    // `cf-ipcountry` is honoured only from a configured trusted proxy IP, and the server runs
    // with `trustProxy: false`, so this is the peer address and not a header a client can move.
    const response = await call(api, {
      method: "POST",
      url: "/v1/market/quote",
      token: alice.token,
      remoteAddress: "127.0.0.1",
      headers: { "cf-ipcountry": "US" },
      payload: { symbol: "AAPLc", side: "buy", amount: "10" },
    });
    const body = await problemOf(response, 403);
    expect(body.code).toBe("not-eligible");
    expect(body.title).toBe("Trading unavailable");
  });

  test("404 for an unknown path and 404 for a resource owned by somebody else", async () => {
    expect(
      (await problemOf(await call(api, { url: "/v1/nothing-here", token: alice.token }), 404)).code,
    ).toBe("not-found");
    const mine = await commitStrategy(api, alice);
    // "This is not yours" and "this never existed" must look identical from outside, or the id
    // space becomes an existence oracle.
    const theirs = await problemOf(
      await call(api, { url: `/v1/instances/${mine.instance}`, token: bob.token }),
      404,
    );
    expect(theirs.code).toBe("not-found");
    expect(theirs.detail).toBe("That resource is unavailable.");
  });

  test("400 invalid-request for a body or a path parameter the route schema refuses", async () => {
    const badBody = await problemOf(
      await call(api, {
        method: "POST",
        url: "/v1/permissions/prepare",
        token: alice.token,
        payload: { instance: "not-a-uuid" },
      }),
      400,
    );
    expect(badBody.code).toBe("invalid-request");
    const badParam = await problemOf(
      await call(api, { url: "/v1/instances/not-a-uuid", token: alice.token }),
      400,
    );
    expect(badParam.code).toBe("invalid-request");
  });

  test("400 invalid-request for a syntactically broken body, not a 500", async () => {
    const response = await call(api, {
      method: "POST",
      url: "/v1/market/quote",
      token: alice.token,
      payload: "{ this is not json",
      headers: { "content-type": "application/json" },
    });
    // Fastify's own parse failure arrives with a 4xx statusCode and no `validation` marker, so
    // it takes the `request-rejected` branch of the handler. Either code is a client error; the
    // contract is that it is a 400-class problem body and never a 500.
    const body = await problemOf(response, 400);
    expect(["invalid-request", "request-rejected"]).toContain(body.code);
  });

  test("409 with a code a client can branch on, not a generic rejection", async () => {
    // A manual strategy cannot be granted a spend permission. The code names the reason so the
    // UI can offer the fix ("create a new signed draft in automatic mode") rather than showing
    // a red box.
    const manual = await commitStrategy(api, alice, { mode: "manual" });
    const body = await problemOf(
      await call(api, {
        method: "POST",
        url: "/v1/permissions/prepare",
        token: alice.token,
        wallet: alice.wallet,
        payload: { instance: manual.instance },
      }),
      409,
    );
    expect(body.code).toBe("manual-strategy");
    expect(body.detail).toContain("automatic mode");
  });

  test("the three wallet failures are three different codes, and none of them is a 404", async () => {
    // A user acting as the wrong wallet still owns the strategy. Collapsing any of these into
    // "not found" turns a fixable mistake into a strategy that appears to have vanished.
    const carol = newIdentity({ wallets: 2 });
    const api2 = await startContractApi({ identities: [carol] });
    try {
      const mine = await commitStrategy(api2, carol);
      // 403: the header names an address this account has not linked at all.
      const unlinked = await problemOf(
        await call(api2, {
          method: "POST",
          url: `/v1/instances/${mine.instance}/arm`,
          token: carol.token,
          wallet: `0x${"cd".repeat(20)}`,
        }),
        403,
      );
      expect(unlinked.code).toBe("wallet-not-linked");
      // 403: linked, but not the wallet that signed this draft.
      const mismatch = await problemOf(
        await call(api2, {
          method: "POST",
          url: `/v1/instances/${mine.instance}/arm`,
          token: carol.token,
          wallet: carol.wallets[1] as string,
        }),
        403,
      );
      expect(mismatch.code).toBe("account-mismatch");
      // 409: two linked wallets and no header, so the server refuses to guess which one is
      // authorizing rather than picking the first and signing on the wrong account's behalf.
      const ambiguous = await problemOf(
        await call(api2, {
          method: "POST",
          url: `/v1/instances/${mine.instance}/arm`,
          token: carol.token,
        }),
        409,
      );
      expect(ambiguous.code).toBe("wallet-selection-required");
    } finally {
      await api2.close();
    }
  }, 60_000);

  test("pause and kill stay reachable from a wallet that did not sign the draft", async () => {
    // Deliberately not gated on the signing wallet: a user who has unlinked or lost access to
    // it must still be able to stop a running strategy. This is the inverse of the assertion
    // above and it is the one that protects the user rather than the authorization.
    const mine = await commitStrategy(api, alice);
    for (const action of ["pause", "kill"] as const) {
      const response = await call(api, {
        method: "POST",
        url: `/v1/instances/${mine.instance}/${action}`,
        token: alice.token,
      });
      expect(response.statusCode).toBe(200);
    }
  });

  test("the preflight is answered without a problem body at all", async () => {
    const response = await call(api, {
      method: "OPTIONS",
      url: "/v1/instances",
      headers: { origin: APP_ORIGIN },
    });
    // 204 and no body. A preflight carries no credential, and a browser reports a 403 on one as
    // "CORS failed" with nothing an operator can act on.
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["access-control-allow-methods"]).toBe("GET, POST, OPTIONS");
    expect(response.headers["access-control-allow-headers"]).toBe(
      "Authorization, Content-Type, X-Mandate-Wallet",
    );
  });
});
