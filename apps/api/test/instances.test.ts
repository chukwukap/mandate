import { afterAll, afterEach, beforeAll, expect, setSystemTime, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { EmbeddedWallet } from "@mandate/auth";
import { type Hex, Problem } from "@mandate/contracts";
import {
  connectDatabase,
  type Database,
  type InstanceRow,
  Repository,
  schema,
  tenant,
} from "@mandate/database";
import { ASSETS, USDC } from "@mandate/evm";
import { type Caps, capsSchema, type Envelope, type Plan, planSchema } from "@mandate/strategy";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import Fastify, { type FastifyInstance } from "fastify";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ZodError } from "zod";
import {
  decideTransition,
  EXPIRY_REASON,
  guardLifecycle,
  type InstancesDependencies,
  registerInstanceAliases,
  registerInstances,
} from "../src/modules/instances/index.js";

const alice = privateKeyToAccount(`0x${"11".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"22".repeat(32)}`);
const nativeUrl = process.env.TEST_DATABASE_URL;
const pglite = nativeUrl ? undefined : new PGlite();
const native = nativeUrl ? connectDatabase(nativeUrl) : undefined;

let database: Database;
let repo: Repository;
let users: { alice: string; bob: string };

// verifyMessage is the only chain read this module performs, and it is real cryptography here,
// not a stub that returns true.
const chain: InstancesDependencies["chain"] = {
  verifyMessage: (address, message, signature) => verifyMessage({ address, message, signature }),
};
// Privy's view of each wallet, as the module reads it: which addresses are delegated to the
// app's signer. Mutable so a test can grant and withdraw between requests.
const delegated = new Set<string>();
let privyDown = false;
const wallets: InstancesDependencies["wallets"] = {
  embedded: async (_did, address): Promise<EmbeddedWallet | null> => {
    if (privyDown) throw new Error("privy: 503 https://auth.privy.io/api/v1/users/app-secret");
    const key = address.toLowerCase();
    return { id: `wallet-${key.slice(2, 8)}`, address: key as Hex, delegated: delegated.has(key) };
  },
};

const plan: Plan = planSchema.parse({
  params: [],
  nodes: [
    {
      id: "cheap",
      op: "lt",
      args: [
        { kind: "feed", feed: "oracle:AAPLc" },
        { kind: "const", value: "300" },
      ],
    },
  ],
  machines: [
    {
      id: "buy",
      scope: "portfolio",
      initial: "watch",
      states: [
        {
          id: "watch",
          transitions: [
            {
              when: "cheap",
              fires: "on_edge",
              to: "watch",
              actions: [
                { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "10" } },
              ],
            },
          ],
        },
      ],
    },
  ],
});

function capsOf(expiresAt: Date): Caps {
  return capsSchema.parse({
    lifetime: "100",
    per_order: "10",
    per_period: "20",
    period_secs: 86400,
    max_orders_per_period: 2,
    cooldown_secs: 60,
    expires_at: expiresAt.toISOString(),
    slippage_bps: 50,
  });
}

// A minimal stand-in for app.ts: the same request decorators and the same Problem -> RFC7807
// mapping, so these routes are exercised over real HTTP without depending on app.ts wiring
// (another process owns it) or colliding with the copies still live in strategies/routes.ts.
const opened: FastifyInstance[] = [];
type Identity = { authorization: string; user: () => string; wallets: Hex[] };
let eligible = true;

async function harness(overrides: Partial<InstancesDependencies> = {}) {
  const identities: Identity[] = [
    {
      authorization: "Bearer alice",
      user: () => users.alice,
      wallets: [alice.address.toLowerCase() as Hex],
    },
    {
      authorization: "Bearer bob",
      user: () => users.bob,
      wallets: [bob.address.toLowerCase() as Hex],
    },
  ];
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.decorateRequest("principal", null);
  app.decorateRequest("jurisdiction", "GB");
  app.decorateRequest("eligible", false);
  app.addHook("onRequest", async (request) => {
    const found = identities.find((i) => i.authorization === request.headers.authorization);
    request.principal = found
      ? {
          privyDid: `did:privy:${found.authorization.split(" ")[1]}`,
          sessionId: "session",
          wallets: found.wallets,
          user: found.user(),
        }
      : null;
    request.jurisdiction = "GB";
    request.eligible = eligible;
  });
  app.setErrorHandler((error, _request, reply) => {
    const problem =
      error instanceof Problem
        ? error
        : error instanceof ZodError || (error as { validation?: unknown }).validation
          ? new Problem(400, "invalid-request", "Invalid request", "Schema mismatch.")
          : new Problem(500, "internal-error", "Unexpected error", "The request failed.");
    void reply
      .code(problem.status)
      .type("application/problem+json")
      .send({ status: problem.status, code: problem.code, detail: problem.detail });
  });
  const deps: InstancesDependencies = {
    repository: overrides.repository ?? repo,
    chain: overrides.chain ?? chain,
    wallets: overrides.wallets ?? wallets,
    ...(overrides.executionAvailable ? { executionAvailable: overrides.executionAvailable } : {}),
  };
  await registerInstances(app, deps);
  await registerInstanceAliases(app, deps);
  opened.push(app);
  return app;
}

let app: FastifyInstance;
const headers = { authorization: "Bearer alice" };
const bobHeaders = { authorization: "Bearer bob" };

beforeAll(async () => {
  if (pglite) {
    const dir = new URL("../../../packages/database/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort())
      await pglite.exec(await readFile(new URL(file, dir), "utf8"));
    // Same unprivileged role the API runs as, so every RLS policy is actually enforced here.
    await pglite.exec(
      "create role api_test nologin; grant usage on schema mandate_v2 to api_test; grant select,insert,update,delete on all tables in schema mandate_v2 to api_test; set role api_test",
    );
  }
  const resolved = pglite ? (drizzle(pglite, { schema }) as unknown as Database) : native?.db;
  if (!resolved) throw new Error("Test database is missing");
  database = resolved;
  repo = new Repository(database);
  users = {
    alice: (await repo.resolvePrivyUser("did:privy:alice")).id,
    bob: (await repo.resolvePrivyUser("did:privy:bob")).id,
  };
  app = await harness();
}, 30000);

afterAll(async () => {
  await Promise.all(opened.splice(0).map((instance) => instance.close()));
  await pglite?.close();
  await native?.close();
});

afterEach(async () => {
  setSystemTime();
  eligible = true;
  privyDown = false;
  delegated.clear();
  await database.delete(schema.workerState);
});

type SeededDraft = { artifact: string; message: string; id: string };

async function seedDraft(
  options: {
    user?: "alice" | "bob";
    account?: string;
    mode?: "manual" | "auto";
    expires?: Date;
    draftExpires?: Date;
  } = {},
): Promise<SeededDraft> {
  const owner = options.user ?? "alice";
  const account = (
    options.account ?? (owner === "alice" ? alice.address : bob.address)
  ).toLowerCase();
  const now = new Date();
  const caps = capsOf(options.expires ?? new Date(now.getTime() + 86_400_000));
  const envelope: Envelope = {
    version: "mandate/2",
    caps,
    assets: [...ASSETS.slice(0, 1)],
    quote: USDC,
    venue: "aerodrome",
  };
  const id = randomUUID();
  const artifact = randomBytes(32).toString("hex");
  const message = `Mandate strategy authorization\nArtifact: ${artifact}\nAccount: ${account}`;
  await repo.saveDraft({
    id,
    userId: users[owner],
    account,
    artifactId: artifact,
    name: "AAPL entry",
    mode: options.mode ?? "manual",
    plan,
    envelope,
    reading: "Structured plan supplied by the user.",
    renderText: "Buy 10 USDC of AAPLc when it trades under 300.",
    renderHash: randomBytes(32).toString("hex"),
    confirmMessage: message,
    createdAt: now,
    expiresAt: options.draftExpires ?? new Date(now.getTime() + 1_800_000),
  });
  return { artifact, message, id };
}

async function createInstance(options: Parameters<typeof seedDraft>[0] = {}) {
  const draft = await seedDraft(options);
  const signer = (options.user ?? "alice") === "alice" ? alice : bob;
  const signature = await signer.signMessage({ message: draft.message });
  const response = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers: (options.user ?? "alice") === "alice" ? headers : bobHeaders,
    payload: { artifact_id: draft.artifact, signature },
  });
  expect(response.statusCode).toBe(201);
  return { ...draft, signature, instance: response.json<{ instance: string }>().instance };
}

async function row(instance: string, owner: "alice" | "bob" = "alice"): Promise<InstanceRow> {
  const found = await tenant(database, users[owner], async (tx) => {
    const [record] = await tx
      .select()
      .from(schema.instances)
      .where(eq(schema.instances.id, instance));
    return record;
  });
  if (!found) throw new Error("instance row missing");
  return found;
}

async function seedEvaluations(instance: string, times: Date[]) {
  await tenant(database, users.alice, async (tx) => {
    for (const at of times)
      await tx.insert(schema.evaluations).values({
        id: randomUUID(),
        userId: users.alice,
        instanceId: instance,
        at,
        outcome: "evaluated",
        admitted: 0,
        refused: null,
        inputs: { "oracle:AAPLc": "320.08" },
        notifications: [],
      });
  });
}

type Body = Record<string, unknown>;
const get = async (url: string, auth = headers) => app.inject({ url, headers: auth });
const post = async (url: string, auth = headers) =>
  app.inject({ method: "POST", url, headers: auth });

test("the transition table is explicit about every status and action", () => {
  for (const status of ["armed", "paused"] as const)
    for (const action of ["arm", "pause", "kill"] as const)
      expect(decideTransition(status, action)).toBe("apply");
  // Both terminal statuses absorb kill without writing, but they are not the same event and so
  // do not share a code: "ended" is only ever written for a lapsed envelope, "halted" carries a
  // halt_reason of its own.
  for (const [status, code] of [
    ["halted", "terminal-instance"],
    ["ended", "expired"],
  ] as const) {
    expect(decideTransition(status, "kill")).toBe("noop");
    for (const action of ["arm", "pause"] as const) {
      const decision = decideTransition(status, action);
      expect(decision).toBeInstanceOf(Problem);
      expect((decision as Problem).status).toBe(409);
      expect((decision as Problem).code).toBe(code);
    }
  }
});

test("a signed draft becomes one paused instance and cannot be replayed", async () => {
  const draft = await seedDraft({ mode: "auto" });
  const signature = await alice.signMessage({ message: draft.message });
  const payload = { artifact_id: draft.artifact, signature };
  const first = await app.inject({ method: "POST", url: "/v1/strategies", headers, payload });
  expect(first.statusCode).toBe(201);
  const body = first.json<Body>();
  expect(body.status).toBe("paused");
  expect(body.mode).toBe("manual");
  expect(body.strategy).toBe(draft.id);
  expect(body.version).toBe(draft.artifact);
  // The draft asked for automatic mode, but the wallet is not delegated: the instance starts
  // manual and the response says what is missing.
  expect(body.needs_automation).toBe(true);
  expect(body.execution_available).toBe(false);
  // A sequential replay is caught by the route's own consumed/expiry read. The concurrent
  // loser instead gets 409 draft-consumed from the atomic UPDATE ... WHERE consumed_at IS NULL
  // inside createInstance, which is the check that actually makes this safe; the next test
  // races two requests to prove it.
  const replay = await app.inject({ method: "POST", url: "/v1/strategies", headers, payload });
  expect(replay.statusCode).toBe(409);
  expect(replay.json<Body>().code).toBe("draft-expired");
  const rows = await repo.list(users.alice, 50);
  expect(rows.filter((r) => r.draft.id === draft.id)).toHaveLength(1);
});

test("two concurrent submissions of one signature create exactly one instance", async () => {
  const draft = await seedDraft();
  const signature = await alice.signMessage({ message: draft.message });
  const payload = { artifact_id: draft.artifact, signature };
  const send = () => app.inject({ method: "POST", url: "/v1/strategies", headers, payload });
  const [first, second] = await Promise.all([send(), send()]);
  expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
  const rows = await repo.list(users.alice, 100);
  expect(rows.filter((r) => r.draft.id === draft.id)).toHaveLength(1);
});

test("creation refuses a signature over anything but the stored review", async () => {
  const draft = await seedDraft();
  const altered = await alice.signMessage({ message: `${draft.message} and also sell everything` });
  const wrong = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: draft.artifact, signature: altered },
  });
  expect(wrong.statusCode).toBe(400);
  expect(wrong.json<Body>().code).toBe("invalid-signature");
  // The wallet that signed must be the wallet the draft records, even with a valid signature.
  const otherWallet = await bob.signMessage({ message: draft.message });
  const mismatch = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: draft.artifact, signature: otherWallet },
  });
  expect(mismatch.statusCode).toBe(400);
});

test("creation is refused for another user's artifact, a lapsed draft and an ineligible region", async () => {
  const mine = await seedDraft();
  const signature = await alice.signMessage({ message: mine.message });
  const stolen = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers: bobHeaders,
    payload: { artifact_id: mine.artifact, signature },
  });
  expect(stolen.statusCode).toBe(404);

  const stale = await seedDraft({ draftExpires: new Date(Date.now() - 1000) });
  const staleSignature = await alice.signMessage({ message: stale.message });
  const expired = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: stale.artifact, signature: staleSignature },
  });
  expect(expired.statusCode).toBe(409);
  expect(expired.json<Body>().code).toBe("draft-expired");

  eligible = false;
  const blocked = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: mine.artifact, signature },
  });
  expect(blocked.statusCode).toBe(403);
  expect(blocked.json<Body>().code).toBe("not-eligible");
});

test("a draft signed by a wallet the caller no longer acts as is refused", async () => {
  const draft = await seedDraft({ account: bob.address });
  const signature = await bob.signMessage({ message: draft.message });
  const response = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: draft.artifact, signature },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json<Body>().code).toBe("account-mismatch");
});

test("arm, pause and kill move an instance and record why it stopped", async () => {
  const { instance } = await createInstance();
  const armed = await post(`/v1/instances/${instance}/arm`);
  expect(armed.statusCode).toBe(200);
  expect(armed.json<Body>().status).toBe("armed");
  // Arming schedules the instance immediately rather than one tick interval out, so a user who
  // pauses and re-arms is not left waiting for a cycle they did not ask for.
  expect(Math.abs(Date.parse(armed.json<Body>().next_tick_at as string) - Date.now())).toBeLessThan(
    5_000,
  );
  const attestation = armed.json<Body>().eligibility_expires_at as string;
  expect(Date.parse(attestation) - Date.now()).toBeGreaterThan(86_000_000);
  expect((await row(instance)).eligibleCountry).toBe("GB");

  // Re-arming an armed instance is a renewal, not a conflict: the worker pauses an instance
  // whose attestation lapsed, and 409 here would strand it behind a whole new signed draft.
  setSystemTime(new Date(Date.now() + 60_000));
  const renewed = await post(`/v1/instances/${instance}/arm`);
  expect(renewed.statusCode).toBe(200);
  expect(Date.parse(renewed.json<Body>().eligibility_expires_at as string)).toBeGreaterThan(
    Date.parse(attestation),
  );
  setSystemTime();

  const paused = await post(`/v1/instances/${instance}/pause`);
  expect(paused.json<Body>().status).toBe("paused");
  expect((await post(`/v1/instances/${instance}/pause`)).statusCode).toBe(200);

  const killed = await post(`/v1/instances/${instance}/kill`);
  expect(killed.json<Body>().status).toBe("halted");
  expect(killed.json<Body>().halt_reason).toBe("Stopped by user");
});

test("a terminal instance refuses arm and pause with 409 and absorbs kill without writing", async () => {
  const { instance } = await createInstance();
  expect((await post(`/v1/instances/${instance}/kill`)).statusCode).toBe(200);
  for (const action of ["arm", "pause"] as const) {
    const response = await post(`/v1/instances/${instance}/${action}`);
    expect(response.statusCode).toBe(409);
    expect(response.json<Body>().code).toBe("terminal-instance");
  }
  const before = await row(instance);
  const again = await post(`/v1/instances/${instance}/kill`);
  expect(again.statusCode).toBe(200);
  expect(again.json<Body>().status).toBe("halted");
  const after = await row(instance);
  // "noop", literally: a second kill must not take a row lock and rewrite the halt reason.
  expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  expect(after.haltReason).toBe("Stopped by user");
});

test("an instance stopped before its envelope lapsed keeps its own reason and its own 409", async () => {
  const expires = new Date(Date.now() + 60_000);
  const { instance } = await createInstance({ expires });
  expect((await post(`/v1/instances/${instance}/kill`)).statusCode).toBe(200);
  const stopped = await row(instance);
  expect(stopped.haltReason).toBe("Stopped by user");
  try {
    setSystemTime(new Date(expires.getTime() + 1000));
    // The guard sees an expired envelope, but the row is already terminal: it must not relabel
    // a strategy the user stopped as one that expired, nor rewrite updated_at to say so.
    const guard = await guardLifecycle(repo, users.alice, instance, new Date());
    expect(guard.expired).toBe(true);
    // Terminal already, so the guard leaves it alone rather than restamping it as an expiry.
    expect(guard.instance.status).toBe("halted");
    expect(guard.instance.haltReason).toBe("Stopped by user");

    const armed = await post(`/v1/instances/${instance}/arm`);
    expect(armed.statusCode).toBe(409);
    // "terminal-instance", not "expired" — the same answer Repository.transition gives, and the
    // one that agrees with the halt_reason shown beside it.
    expect(armed.json<Body>().code).toBe("terminal-instance");
    expect((await post(`/v1/instances/${instance}/pause`)).json<Body>().code).toBe(
      "terminal-instance",
    );
    const after = await row(instance);
    expect(after.status).toBe("halted");
    expect(after.haltReason).toBe("Stopped by user");
    expect(after.updatedAt.getTime()).toBe(stopped.updatedAt.getTime());
  } finally {
    setSystemTime();
  }
});

test("an expired envelope ends the instance on the next lifecycle call, and kill keeps the real reason", async () => {
  const expires = new Date(Date.now() + 60_000);
  const { instance } = await createInstance({ expires });
  expect((await post(`/v1/instances/${instance}/arm`)).json<Body>().status).toBe("armed");
  try {
    setSystemTime(new Date(expires.getTime() + 1000));
    // Reads stay reads: the stored status is reported as-is, nothing is written by a GET.
    expect((await get(`/v1/instances/${instance}`)).json<Body>().status).toBe("armed");

    const paused = await post(`/v1/instances/${instance}/pause`);
    expect(paused.statusCode).toBe(409);
    expect(paused.json<Body>().code).toBe("expired");
    const ended = await row(instance);
    expect(ended.status).toBe("ended");
    // Identical to the string packages/execution/src/admission.ts writes for the same event.
    expect(ended.haltReason).toBe(EXPIRY_REASON);
    expect(ended.haltReason).toBe("Strategy expired");

    const armed = await post(`/v1/instances/${instance}/arm`);
    expect(armed.statusCode).toBe(409);
    expect(armed.json<Body>().code).toBe("expired");

    // Kill still succeeds — the user asked for it to stop and it has — but it must not relabel
    // an expiry as "Stopped by user".
    const killed = await post(`/v1/instances/${instance}/kill`);
    expect(killed.statusCode).toBe(200);
    expect(killed.json<Body>().status).toBe("ended");
    expect(killed.json<Body>().halt_reason).toBe("Strategy expired");
  } finally {
    setSystemTime();
  }
});

test("expiry is materialised even for an instance that was only ever paused", async () => {
  const expires = new Date(Date.now() + 60_000);
  const { instance } = await createInstance({ expires });
  try {
    setSystemTime(new Date(expires.getTime() + 1000));
    const response = await post(`/v1/instances/${instance}/pause`);
    expect(response.statusCode).toBe(409);
    // A paused instance is never scheduled again, so no worker tick would ever have ended it.
    expect((await row(instance)).status).toBe("ended");
  } finally {
    setSystemTime();
  }
});

test("a draft that asked for automatic mode goes auto at creation when the wallet is delegated", async () => {
  delegated.add(alice.address.toLowerCase());
  const draft = await seedDraft({ mode: "auto" });
  const signature = await alice.signMessage({ message: draft.message });
  const created = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: draft.artifact, signature },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json<Body>()).toMatchObject({
    status: "paused",
    mode: "auto",
    needs_automation: false,
  });
  // Still paused: delegation is consent to sign, arming is the decision to run.
  expect((await row(created.json<{ instance: string }>().instance)).status).toBe("paused");

  // A manual draft is unaffected by the delegation either way.
  const manual = await createInstance({ mode: "manual" });
  const view = (await get(`/v1/instances/${manual.instance}`)).json<Body>();
  expect(view.mode).toBe("manual");
  expect(view.requested_mode).toBe("manual");
});

test("arming an automatic instance requires the wallet's delegation, read live from Privy", async () => {
  const { instance } = await createInstance({ mode: "auto" });
  expect((await row(instance)).mode).toBe("manual");

  const refused = await post(`/v1/instances/${instance}/arm`);
  expect(refused.statusCode).toBe(409);
  expect(refused.json<Body>().code).toBe("automation-required");
  expect(refused.json<Body>().detail).toContain("Turn on automatic buying");
  // Refused means untouched: still paused, still manual.
  expect((await row(instance)).status).toBe("paused");
  expect((await row(instance)).mode).toBe("manual");

  delegated.add(alice.address.toLowerCase());
  const armed = await post(`/v1/instances/${instance}/arm`);
  expect(armed.statusCode).toBe(200);
  expect(armed.json<Body>().status).toBe("armed");
  expect(armed.json<Body>().mode).toBe("auto");

  // Once auto, re-arming does not consult Privy: the worker re-reads the delegation before
  // every signature, and POST /v1/me/automation is the path that turns a withdrawn delegation
  // into a paused, manual instance.
  await post(`/v1/instances/${instance}/pause`);
  delegated.clear();
  const rearmed = await post(`/v1/instances/${instance}/arm`);
  expect(rearmed.statusCode).toBe(200);
  expect(rearmed.json<Body>().mode).toBe("auto");
});

test("an unreachable Privy is 503, never a 500 and never an armed instance", async () => {
  const { instance } = await createInstance({ mode: "auto" });
  privyDown = true;
  const response = await post(`/v1/instances/${instance}/arm`);
  expect(response.statusCode).toBe(503);
  expect(response.json<Body>().code).toBe("unavailable");
  // The Privy SDK error carries the request URL; it must not reach the client.
  expect(JSON.stringify(response.json())).not.toContain("privy.io");
  expect((await row(instance)).status).toBe("paused");
  expect((await row(instance)).mode).toBe("manual");

  // At creation the same outage is not an error: the instance exists and is simply manual.
  const draft = await seedDraft({ mode: "auto" });
  const signature = await alice.signMessage({ message: draft.message });
  const created = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: draft.artifact, signature },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json<Body>()).toMatchObject({ mode: "manual", needs_automation: true });
});

test("arm acts as the wallet the request selects, and reads are open to any owner", async () => {
  const { instance } = await createInstance();
  // X-Mandate-Wallet names which linked wallet is acting. An address Privy has not verified for
  // this user is never accepted, even though it is the signer of some other draft.
  const foreign = await app.inject({
    method: "POST",
    url: `/v1/instances/${instance}/arm`,
    headers: { ...headers, "x-mandate-wallet": bob.address },
  });
  expect(foreign.statusCode).toBe(403);
  expect(foreign.json<Body>().code).toBe("wallet-not-linked");
  const own = await app.inject({
    method: "POST",
    url: `/v1/instances/${instance}/arm`,
    headers: { ...headers, "x-mandate-wallet": alice.address },
  });
  expect(own.statusCode).toBe(200);

  // Reads are not gated on eligibility: a user who moved to an unsupported region must still be
  // able to see what is running under their name — and, below, to stop it.
  eligible = false;
  expect((await get("/v1/instances")).statusCode).toBe(200);
  expect((await get(`/v1/instances/${instance}`)).statusCode).toBe(200);
  expect((await get(`/v1/instances/${instance}/evaluations`)).statusCode).toBe(200);
});

test("pause and kill stay available to a caller who is no longer eligible", async () => {
  const { instance } = await createInstance();
  await post(`/v1/instances/${instance}/arm`);
  eligible = false;
  expect((await post(`/v1/instances/${instance}/arm`)).statusCode).toBe(403);
  expect((await post(`/v1/instances/${instance}/pause`)).json<Body>().status).toBe("paused");
  expect((await post(`/v1/instances/${instance}/kill`)).json<Body>().status).toBe("halted");
});

test("another user sees 404 everywhere and an empty list", async () => {
  const { instance } = await createInstance();
  for (const tail of ["", "/evaluations"])
    expect((await get(`/v1/instances/${instance}${tail}`, bobHeaders)).statusCode).toBe(404);
  for (const action of ["arm", "pause", "kill"] as const)
    expect((await post(`/v1/instances/${instance}/${action}`, bobHeaders)).statusCode).toBe(404);
  expect((await get("/v1/instances", bobHeaders)).json<{ items: unknown[] }>().items).toHaveLength(
    0,
  );
  // Unauthenticated is 401, and still not a disclosure of whether the id exists.
  expect((await app.inject({ url: `/v1/instances/${instance}` })).statusCode).toBe(401);
  expect((await row(instance)).status).toBe("paused");
});

test("the list is keyset paged and keeps instances that share a created_at", async () => {
  const fixed = new Date(Date.now() + 3_600_000);
  const created: string[] = [];
  try {
    setSystemTime(fixed);
    created.push((await createInstance()).instance, (await createInstance()).instance);
  } finally {
    setSystemTime();
  }
  const rows = await repo.list(users.alice, 100);
  const sharing = rows.filter((r) => r.instance.createdAt.getTime() === fixed.getTime());
  expect(sharing).toHaveLength(2);

  type Page = { items: { id: string }[]; next_page: { before: string; before_id: string } | null };
  const first = (await get("/v1/instances?limit=1")).json<Page>();
  expect(first.items).toHaveLength(1);
  if (!first.next_page) throw new Error("expected a cursor");
  const query = new URLSearchParams({ limit: "1", ...first.next_page });
  const second = (await get(`/v1/instances?${query}`)).json<Page>();
  expect(new Set([first.items[0]?.id, second.items[0]?.id])).toEqual(new Set(created));

  // Walking to the end returns every instance exactly once and finishes with a null cursor.
  const seen: string[] = [];
  let cursor: Page["next_page"] = null;
  for (let page = 0; page < 20; page += 1) {
    const url: string = cursor
      ? `/v1/instances?${new URLSearchParams({ limit: "2", ...cursor })}`
      : "/v1/instances?limit=2";
    const body = (await get(url)).json<Page>();
    seen.push(...body.items.map((item) => item.id));
    cursor = body.next_page;
    if (!cursor) break;
  }
  expect(cursor).toBeNull();
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen).toEqual(rows.map((r) => r.instance.id));
});

test("pagination input is validated in zod, not by a coercing JSON schema", async () => {
  // app.ts builds ajv with coerceTypes:false. A declared integer `limit` in the route schema
  // would reject every ?limit=50 with a 400, which is why this stays a zod parse.
  expect((await get("/v1/instances?limit=2")).statusCode).toBe(200);
  expect((await get("/v1/instances?limit=999")).statusCode).toBe(400);
  expect((await get("/v1/instances?limit=0")).statusCode).toBe(400);
  expect((await get(`/v1/instances?before_id=${randomUUID()}`)).statusCode).toBe(400);
  expect((await get("/v1/instances/not-a-uuid")).statusCode).toBe(400);
});

test("/v1/strategies is the same list as /v1/instances", async () => {
  await createInstance();
  const alias = await get("/v1/strategies?limit=5");
  const canonical = await get("/v1/instances?limit=5");
  expect(alias.statusCode).toBe(200);
  expect(alias.json()).toEqual(canonical.json());
});

test("the detail read returns the signed authority verbatim", async () => {
  const { instance, id } = await createInstance();
  const body = (await get(`/v1/instances/${instance}`)).json<Body>();
  expect(body.strategy).toBe(id);
  expect(body.account).toBe(alice.address.toLowerCase());
  expect(body.render_text).toBe("Buy 10 USDC of AAPLc when it trades under 300.");
  expect((body.envelope as Envelope).caps.lifetime).toBe("100");
  expect((body.plan as Plan).machines[0]?.id).toBe("buy");
  // Money stays a string end to end; a float would misrepresent a user's own spend.
  expect(body.spent).toBe("0");
  expect(body.lifetime).toBe("100");
  expect(typeof body.spent).toBe("string");
  expect(body.orders).toBe(0);
});

test("the evaluations feed pages newest first and returns rows as stored", async () => {
  const { instance } = await createInstance();
  const base = Date.now() - 10_000;
  const times = [new Date(base), new Date(base + 1000), new Date(base + 2000)];
  await seedEvaluations(instance, times);
  type Feed = {
    items: {
      id: string;
      at: string;
      outcome: string;
      admitted: number;
      inputs: Record<string, string>;
      notifications: string[];
      refused: string | null;
    }[];
    next_page: { before: string; before_id: string } | null;
  };
  const first = (await get(`/v1/instances/${instance}/evaluations?limit=2`)).json<Feed>();
  expect(first.items).toHaveLength(2);
  expect(Date.parse(first.items[0]?.at ?? "")).toBe(base + 2000);
  // The shape apps/web reads, unmodified.
  expect(first.items[0]?.outcome).toBe("evaluated");
  expect(first.items[0]?.admitted).toBe(0);
  expect(first.items[0]?.refused).toBeNull();
  expect(first.items[0]?.notifications).toEqual([]);
  expect(first.items[0]?.inputs).toEqual({ "oracle:AAPLc": "320.08" });
  if (!first.next_page) throw new Error("expected a cursor");
  expect(first.next_page.before).toBe(new Date(base + 1000).toISOString());

  const query = new URLSearchParams({ limit: "2", ...first.next_page });
  const second = (await get(`/v1/instances/${instance}/evaluations?${query}`)).json<Feed>();
  expect(second.items).toHaveLength(1);
  expect(Date.parse(second.items[0]?.at ?? "")).toBe(base);
  expect(second.next_page).toBeNull();

  const empty = (
    await get(`/v1/instances/${(await createInstance()).instance}/evaluations`)
  ).json<Feed>();
  expect(empty.items).toHaveLength(0);
  expect(empty.next_page).toBeNull();
});

test("evaluations recorded in the same millisecond are not dropped by the cursor", async () => {
  const { instance } = await createInstance();
  const at = new Date(Date.now() - 5_000);
  await seedEvaluations(instance, [at, at, at]);
  type Feed = { items: { id: string }[]; next_page: { before: string; before_id: string } | null };
  const seen: string[] = [];
  let cursor: Feed["next_page"] = null;
  for (let page = 0; page < 5; page += 1) {
    const url: string = cursor
      ? `/v1/instances/${instance}/evaluations?${new URLSearchParams({ limit: "1", ...cursor })}`
      : `/v1/instances/${instance}/evaluations?limit=1`;
    const body = (await get(url)).json<Feed>();
    seen.push(...body.items.map((item) => item.id));
    cursor = body.next_page;
    if (!cursor) break;
  }
  expect(new Set(seen).size).toBe(3);
});

test("execution_available follows the worker heartbeat and fails closed", async () => {
  const { instance } = await createInstance();
  expect((await get(`/v1/instances/${instance}`)).json<Body>().execution_available).toBe(false);
  await database.insert(schema.workerState).values({
    id: 1,
    generation: randomUUID(),
    heartbeatAt: new Date(),
    executionAvailable: 1,
  });
  expect((await get(`/v1/instances/${instance}`)).json<Body>().execution_available).toBe(true);
  const list = await get("/v1/instances?limit=5");
  expect(list.json<{ items: Body[] }>().items.every((item) => item.execution_available)).toBe(true);

  // A stale heartbeat is not a live worker.
  await database
    .update(schema.workerState)
    .set({ heartbeatAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.workerState.id, 1));
  expect((await get(`/v1/instances/${instance}`)).json<Body>().execution_available).toBe(false);

  // And a heartbeat read that throws degrades the flag rather than failing the request.
  const broken = await harness({
    executionAvailable: async () => {
      throw new Error("database unavailable");
    },
  });
  const response = await broken.inject({ url: `/v1/instances/${instance}`, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json<Body>().execution_available).toBe(false);
});
