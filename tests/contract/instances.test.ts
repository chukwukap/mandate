import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EQUITY_DECIMALS } from "../../packages/contracts/src/index.js";
import {
  BUY_PLAN,
  type ContractApi,
  call,
  commitStrategy,
  draftCaps,
  newIdentity,
  seedEvaluation,
  startContractApi,
  type TestIdentity,
} from "./harness.js";
import {
  createdInstanceSchema,
  draftSchema,
  evaluationSchema,
  instanceDetailSchema,
  instanceSchema,
  pageOf,
  parsed,
  problemSchema,
} from "./schemas.js";

/**
 * The authoring and lifecycle surface: draft, sign, submit, list, read, arm, pause, kill.
 *
 * Two of these responses are the signed authority itself and not merely a view of it. The draft
 * carries `render_text` and `confirm_message` — the exact bytes a wallet is asked to sign — and
 * the instance detail hands them back verbatim so a client can re-display or re-hash what was
 * authorized. Neither may be recomputed on the way out: a rebuilt render hashes differently from
 * the one the signature covers, which is how a user ends up unable to prove what they agreed to.
 */

let api: ContractApi;
let alice: TestIdentity;
let user: string;

beforeAll(async () => {
  alice = newIdentity();
  api = await startContractApi({ identities: [alice] });
  user = (await call(api, { url: "/v1/me", token: alice.token })).json<{ user: string }>().user;
}, 60_000);

afterAll(async () => {
  await api.close();
}, 30_000);

function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "AAPL entry",
    plan: BUY_PLAN,
    caps: draftCaps(),
    assets: ["AAPLc"],
    mode: "manual",
    ...overrides,
  };
}

describe("POST /v1/strategies/draft", () => {
  test("returns 201 with the artifact, the render and the exact message to sign", async () => {
    const response = await call(api, {
      method: "POST",
      url: "/v1/strategies/draft",
      token: alice.token,
      wallet: alice.wallet,
      payload: draftBody(),
    });
    expect(response.statusCode).toBe(201);
    const body = parsed(draftSchema, response.json());
    // `render_sha256` is a hash of `render_text` and of nothing else. A client that re-hashes
    // the words it displayed must get this value back, or it cannot prove the review it showed
    // is the review the artifact id commits to.
    expect(createHash("sha256").update(body.render_text).digest("hex")).toBe(body.render_sha256);
    // The message binds origin, chain, account and artifact. Dropping any one of them makes a
    // signature replayable somewhere it was never meant to authorize.
    expect(body.confirm_message).toContain("Mandate strategy authorization");
    expect(body.confirm_message).toContain(`Chain: 8453`);
    expect(body.confirm_message).toContain(`Account: ${alice.wallet}`);
    expect(body.confirm_message).toContain(`Artifact: ${body.artifact_id}`);
    // The render is inside the message, so the signature covers the words, not just the digest.
    expect(body.confirm_message).toContain(body.render_text);
  });

  test("the signing window is short and never outlives the caps expiry", async () => {
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    const body = parsed(
      draftSchema,
      (
        await call(api, {
          method: "POST",
          url: "/v1/strategies/draft",
          token: alice.token,
          wallet: alice.wallet,
          payload: draftBody({ caps: draftCaps({ expires_at: soon }) }),
        })
      ).json(),
    );
    // min(now + 30 minutes, caps.expires_at). A draft that could be signed after the strategy
    // it authorizes has expired is an authorization for nothing.
    expect(Date.parse(body.expires_at)).toBeLessThanOrEqual(Date.parse(soon));
  });

  test("an expiry inside a minute or beyond a year is a 400 with its own code", async () => {
    for (const expires_at of [
      new Date(Date.now() + 30_000).toISOString(),
      new Date(Date.now() + 400 * 86_400_000).toISOString(),
    ]) {
      const response = await call(api, {
        method: "POST",
        url: "/v1/strategies/draft",
        token: alice.token,
        wallet: alice.wallet,
        payload: draftBody({ caps: draftCaps({ expires_at }) }),
      });
      expect(response.statusCode).toBe(400);
      expect(parsed(problemSchema, response.json()).code).toBe("invalid-expiry");
    }
  });

  test("an unknown catalogue symbol is named in the detail, not swallowed", async () => {
    const response = await call(api, {
      method: "POST",
      url: "/v1/strategies/draft",
      token: alice.token,
      wallet: alice.wallet,
      payload: draftBody({ assets: ["NOTREAL"] }),
    });
    expect(response.statusCode).toBe(400);
    const body = parsed(problemSchema, response.json());
    expect(body.code).toBe("unknown-asset");
    expect(body.detail).toContain("NOTREAL");
  });

  test("the envelope carries each asset's real scale, so the signature commits to it", async () => {
    const body = (
      await call(api, {
        method: "POST",
        url: "/v1/strategies/draft",
        token: alice.token,
        wallet: alice.wallet,
        payload: draftBody(),
      })
    ).json<{ envelope: { assets: { symbol: string; decimals: number }[]; quote: string } }>();
    // The envelope is what the worker sizes orders against, so a wrong scale here is a 1e10
    // mispricing that the user has already signed for.
    for (const asset of body.envelope.assets) expect(asset.decimals).toBe(EQUITY_DECIMALS);
    expect(body.envelope.quote.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  });
});

describe("POST /v1/strategies", () => {
  test("returns 201 naming the draft, the artifact and the new instance", async () => {
    const draft = await call(api, {
      method: "POST",
      url: "/v1/strategies/draft",
      token: alice.token,
      wallet: alice.wallet,
      payload: draftBody({ mode: "auto" }),
    });
    const artifact = draft.json<{ artifact_id: string; confirm_message: string }>();
    const signature = api.chain.sign(alice.wallet, artifact.confirm_message);
    const response = await call(api, {
      method: "POST",
      url: "/v1/strategies",
      token: alice.token,
      wallet: alice.wallet,
      payload: { artifact_id: artifact.artifact_id, signature },
    });
    expect(response.statusCode).toBe(201);
    const body = parsed(createdInstanceSchema, response.json());
    expect(body.version).toBe(artifact.artifact_id);
    // Requesting auto in the draft grants nothing. Instances always start paused and manual;
    // the wallet has no server signer in this fixture.
    expect(body.status).toBe("paused");
    expect(body.mode).toBe("manual");
    expect(body.needs_automation).toBe(true);
  });

  test("a signature over anything but the stored message is refused", async () => {
    const draft = await call(api, {
      method: "POST",
      url: "/v1/strategies/draft",
      token: alice.token,
      wallet: alice.wallet,
      payload: draftBody(),
    });
    const artifact = draft.json<{ artifact_id: string; confirm_message: string }>();
    // Signed over a message that differs by one character from the stored review.
    const wrong = api.chain.sign(alice.wallet, `${artifact.confirm_message} `);
    const response = await call(api, {
      method: "POST",
      url: "/v1/strategies",
      token: alice.token,
      wallet: alice.wallet,
      payload: { artifact_id: artifact.artifact_id, signature: wrong },
    });
    expect(response.statusCode).toBe(400);
    const body = parsed(problemSchema, response.json());
    expect(body.code).toBe("invalid-signature");
    expect(body.detail).toContain("Sign the exact saved review");
  });

  test("one signature creates one instance; a replay is a 409 and never a second one", async () => {
    const draft = await call(api, {
      method: "POST",
      url: "/v1/strategies/draft",
      token: alice.token,
      wallet: alice.wallet,
      payload: draftBody(),
    });
    const artifact = draft.json<{ artifact_id: string; confirm_message: string }>();
    const signature = api.chain.sign(alice.wallet, artifact.confirm_message);
    const submit = () =>
      call(api, {
        method: "POST",
        url: "/v1/strategies",
        token: alice.token,
        wallet: alice.wallet,
        payload: { artifact_id: artifact.artifact_id, signature },
      });
    expect((await submit()).statusCode).toBe(201);
    const replay = await submit();
    expect(replay.statusCode).toBe(409);
    // Sequential replay lands as "draft-expired" and a concurrent one as "draft-consumed".
    // Both are 409 and both mean the same thing to a client: sign a fresh draft.
    expect(["draft-expired", "draft-consumed"]).toContain(
      parsed(problemSchema, replay.json()).code,
    );
  });
});

describe("GET /v1/instances", () => {
  test("the page shape is items plus a cursor with both halves or null", async () => {
    const dave = newIdentity();
    const api2 = await startContractApi({ identities: [dave] });
    try {
      for (let i = 0; i < 3; i++) await commitStrategy(api2, dave);
      const first = await call(api2, { url: "/v1/instances?limit=2", token: dave.token });
      expect(first.statusCode).toBe(200);
      const page = parsed(pageOf(instanceSchema), first.json());
      expect(page.items).toHaveLength(2);
      expect(page.next_page).not.toBeNull();
      // A timestamp alone is not a key: instances created inside the same millisecond share a
      // created_at, and a timestamp-only cursor either loses one of them or loops on it.
      expect(page.next_page?.before_id).toBe(page.items[1]?.id as string);

      const second = await call(api2, {
        url: `/v1/instances?limit=2&before=${encodeURIComponent(page.next_page?.before as string)}&before_id=${page.next_page?.before_id}`,
        token: dave.token,
      });
      const rest = parsed(pageOf(instanceSchema), second.json());
      expect(rest.items).toHaveLength(1);
      expect(rest.next_page).toBeNull();
      // No row appears twice across the boundary and none is skipped.
      const ids = [...page.items, ...rest.items].map((item) => item.id);
      expect(new Set(ids).size).toBe(3);
    } finally {
      await api2.close();
    }
  }, 60_000);

  test("before_id without before is refused rather than silently ignored", async () => {
    const response = await call(api, {
      url: `/v1/instances?before_id=${crypto.randomUUID()}`,
      token: alice.token,
    });
    // Half a cursor is not a cursor. Accepting it would return the first page again, which an
    // infinite scroll reads as "no more rows" or as a loop, depending on the client.
    expect(response.statusCode).toBe(400);
    expect(parsed(problemSchema, response.json()).code).toBe("invalid-request");
  });

  test("GET /v1/strategies is byte-identical to GET /v1/instances", async () => {
    const eve = newIdentity();
    const api2 = await startContractApi({ identities: [eve] });
    try {
      await commitStrategy(api2, eve);
      const [instances, strategies] = await Promise.all([
        call(api2, { url: "/v1/instances", token: eve.token }),
        call(api2, { url: "/v1/strategies", token: eve.token }),
      ]);
      // A compatibility surface for older clients, not a second contract to maintain. The
      // moment the two diverge, one of them is wrong and nothing says which.
      expect(strategies.json()).toEqual(instances.json());
      parsed(pageOf(instanceSchema), strategies.json());
    } finally {
      await api2.close();
    }
  }, 60_000);
});

describe("GET /v1/instances/:id", () => {
  test("the detail returns the signed artifact verbatim alongside the summary", async () => {
    const draft = await call(api, {
      method: "POST",
      url: "/v1/strategies/draft",
      token: alice.token,
      wallet: alice.wallet,
      payload: draftBody(),
    });
    const artifact = draft.json<{
      artifact_id: string;
      confirm_message: string;
      render_text: string;
      render_sha256: string;
    }>();
    const created = await call(api, {
      method: "POST",
      url: "/v1/strategies",
      token: alice.token,
      wallet: alice.wallet,
      payload: {
        artifact_id: artifact.artifact_id,
        signature: api.chain.sign(alice.wallet, artifact.confirm_message),
      },
    });
    const instance = created.json<{ instance: string }>().instance;
    const response = await call(api, { url: `/v1/instances/${instance}`, token: alice.token });
    expect(response.statusCode).toBe(200);
    const body = parsed(instanceDetailSchema, response.json());
    // Returned from the stored draft row, never re-rendered: a rebuilt render would hash
    // differently from the one the signature covers.
    expect(body.render_text).toBe(artifact.render_text);
    expect(body.render_sha256).toBe(artifact.render_sha256);
    expect(body.account).toBe(alice.wallet);
    // `strategy` is the draft id and not the instance id. Two names that do not match their
    // column, and renaming either silently blanks a panel in apps/web rather than erroring.
    expect(body.strategy).not.toBe(body.id);
    expect(body.spent).toBe("0");
    expect(body.lifetime).toBe("100");
  });
});

describe("the lifecycle routes", () => {
  test("arm, pause and kill all answer with the instance summary at its new status", async () => {
    const committed = await commitStrategy(api, alice);
    const transitions: [string, string][] = [
      ["arm", "armed"],
      ["pause", "paused"],
      ["kill", "halted"],
    ];
    for (const [action, status] of transitions) {
      const response = await call(api, {
        method: "POST",
        url: `/v1/instances/${committed.instance}/${action}`,
        token: alice.token,
        wallet: alice.wallet,
      });
      expect(response.statusCode).toBe(200);
      const body = parsed(instanceSchema, response.json());
      expect(body.status).toBe(status as (typeof body)["status"]);
      expect(body.id).toBe(committed.instance);
    }
    // "halted" carries its own reason, which is the only record of why a strategy stopped;
    // "ended" is expiry and nothing else writes it. Collapsing the two erases that.
    const halted = parsed(
      instanceSchema,
      (await call(api, { url: `/v1/instances/${committed.instance}`, token: alice.token })).json(),
    );
    expect(halted.status).toBe("halted");
    expect(halted.halt_reason).not.toBeNull();
  });

  test("a terminal instance cannot be re-armed, and the 409 says which state it is in", async () => {
    const committed = await commitStrategy(api, alice);
    await call(api, {
      method: "POST",
      url: `/v1/instances/${committed.instance}/kill`,
      token: alice.token,
    });
    const response = await call(api, {
      method: "POST",
      url: `/v1/instances/${committed.instance}/arm`,
      token: alice.token,
      wallet: alice.wallet,
    });
    expect(response.statusCode).toBe(409);
    // Continuing requires a newly signed draft; there is no path back from a terminal status.
    expect(parsed(problemSchema, response.json()).code).toMatch(/halted|ended|terminal|expired/);
  });

  test("arming records the eligibility window the tick will later be checked against", async () => {
    const committed = await commitStrategy(api, alice);
    const armed = parsed(
      instanceSchema,
      (
        await call(api, {
          method: "POST",
          url: `/v1/instances/${committed.instance}/arm`,
          token: alice.token,
          wallet: alice.wallet,
        })
      ).json(),
    );
    // Set by `arm` and read by the worker: an armed instance whose attestation has lapsed is
    // paused with "eligibility-renewal-required" rather than traded.
    expect(armed.eligibility_expires_at).not.toBeNull();
    expect(Date.parse(armed.eligibility_expires_at as string)).toBeGreaterThan(Date.now());
  });
});

describe("GET /v1/instances/:id/evaluations", () => {
  test("rows pass through exactly as stored, camelCase keys included", async () => {
    const committed = await commitStrategy(api, alice);
    const at = new Date();
    await seedEvaluation(api, user, committed.instance, {
      at,
      outcome: "evaluated",
      admitted: 1,
      refused: "Cooldown active; Per-order cap exceeded",
      inputs: { "oracle:AAPLc": "320.08", "dex:AAPLc": "320.220106" },
    });
    const response = await call(api, {
      url: `/v1/instances/${committed.instance}/evaluations`,
      token: alice.token,
    });
    expect(response.statusCode).toBe(200);
    const page = parsed(pageOf(evaluationSchema), response.json());
    const row = page.items[0];
    // apps/web reads id/at/outcome/admitted/refused/notifications/inputs off this exact shape.
    // Reshaping it to snake_case would empty the history panel without erroring anywhere.
    expect(row?.outcome).toBe("evaluated");
    expect(row?.admitted).toBe(1);
    expect(row?.inputs).toEqual({ "oracle:AAPLc": "320.08", "dex:AAPLc": "320.220106" });
    // `tick()` joins refusals with "; " into one column; the raw string is what is stored and
    // what is returned, so a consumer can split it the same way the summary route does.
    expect(row?.refused).toContain("Cooldown active");
    // `userId` is the caller's own id, which /v1/me already returns to them.
    expect(row?.userId).toBe(user);
  });

  test("evaluations for somebody else's instance are 404, not an empty page", async () => {
    const frank = newIdentity();
    const api2 = await startContractApi({ identities: [alice, frank] });
    try {
      const mine = await commitStrategy(api2, alice);
      const response = await call(api2, {
        url: `/v1/instances/${mine.instance}/evaluations`,
        token: frank.token,
      });
      // An empty page reads as "your strategy never ticked". It has to be indistinguishable
      // from an id that never existed.
      expect(response.statusCode).toBe(404);
      expect(parsed(problemSchema, response.json()).code).toBe("not-found");
    } finally {
      await api2.close();
    }
  }, 60_000);
});
