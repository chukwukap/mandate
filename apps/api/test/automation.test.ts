import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { EmbeddedWallet } from "@mandate/auth";
import { type Config, loadConfig } from "@mandate/config";
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
  type AutomationDependencies,
  registerAutomation,
} from "../src/modules/automation/index.js";
import {
  type InstancesDependencies,
  registerInstanceAliases,
  registerInstances,
} from "../src/modules/instances/index.js";

/**
 * POST /v1/me/automation: the one write that turns a wallet's delegation into instance modes.
 *
 * Registered beside the instances module so the assertions are about real rows moving — an
 * instance the user armed being paused when consent is withdrawn is the property that matters,
 * and it is only observable through the same repository the arm route writes.
 */

const alice = privateKeyToAccount(`0x${"11".repeat(32)}`);
const external = privateKeyToAccount(`0x${"22".repeat(32)}`);
const mallory = privateKeyToAccount(`0x${"33".repeat(32)}`);
const SIGNER = "kq_test_signer";
const nativeUrl = process.env.TEST_DATABASE_URL;
const pglite = nativeUrl ? undefined : new PGlite();
const native = nativeUrl ? connectDatabase(nativeUrl) : undefined;

let database: Database;
let repo: Repository;
let user: string;

const chain: InstancesDependencies["chain"] = {
  verifyMessage: (address, message, signature) => verifyMessage({ address, message, signature }),
};
/** Alice's wallet is embedded. `delegated` is what the tests flip; `external` is never embedded. */
const delegated = new Set<string>();
let privyDown = false;
const wallets: AutomationDependencies["wallets"] = {
  embedded: async (_did, address): Promise<EmbeddedWallet | null> => {
    if (privyDown) throw new Error("privy: 503 https://auth.privy.io/api/v1/users/app-secret");
    const key = address.toLowerCase();
    if (key !== alice.address.toLowerCase()) return null;
    return { id: "wallet-alice", address: key as Hex, delegated: delegated.has(key) };
  },
};

function settings(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://local:local@localhost/test",
    PRIVY_APP_ID: "test",
    PRIVY_APP_SECRET: "secret",
    LOG_LEVEL: "silent",
    ELIGIBLE_COUNTRIES: "GB",
    PRIVY_KEY_QUORUM_ID: SIGNER,
    ...overrides,
  });
}

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

const caps: Caps = capsSchema.parse({
  lifetime: "100",
  per_order: "10",
  per_period: "20",
  period_secs: 86400,
  max_orders_per_period: 2,
  cooldown_secs: 60,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  slippage_bps: 50,
});

const opened: FastifyInstance[] = [];

async function harness(config: Config = settings()) {
  const app = Fastify({
    logger: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  app.decorateRequest("principal", null);
  app.decorateRequest("jurisdiction", "GB");
  app.decorateRequest("eligible", false);
  app.addHook("onRequest", async (request) => {
    request.principal =
      request.headers.authorization === "Bearer alice"
        ? {
            privyDid: "did:privy:alice",
            sessionId: "session",
            // Two linked wallets: the embedded one and an external one the user also linked.
            wallets: [alice.address.toLowerCase() as Hex, external.address.toLowerCase() as Hex],
            user,
          }
        : null;
    request.jurisdiction = "GB";
    request.eligible = true;
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
  const instances: InstancesDependencies = { repository: repo, chain, wallets };
  await registerInstances(app, instances);
  await registerInstanceAliases(app, instances);
  await registerAutomation(app, config, { repository: repo, wallets });
  opened.push(app);
  return app;
}

let app: FastifyInstance;
const headers = { authorization: "Bearer alice" };

beforeAll(async () => {
  if (pglite) {
    const dir = new URL("../../../packages/database/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort())
      await pglite.exec(await readFile(new URL(file, dir), "utf8"));
    await pglite.exec(
      "create role api_test nologin; grant usage on schema mandate_v2 to api_test; grant select,insert,update,delete on all tables in schema mandate_v2 to api_test; set role api_test",
    );
  }
  const resolved = pglite ? (drizzle(pglite, { schema }) as unknown as Database) : native?.db;
  if (!resolved) throw new Error("Test database is missing");
  database = resolved;
  repo = new Repository(database);
  user = (await repo.resolvePrivyUser("did:privy:automation")).id;
  app = await harness();
}, 30000);

afterAll(async () => {
  await Promise.all(opened.splice(0).map((instance) => instance.close()));
  await pglite?.close();
  await native?.close();
});

afterEach(() => {
  delegated.clear();
  privyDown = false;
});

/** A signed draft turned into an instance through the real create route. */
async function createInstance(options: { mode?: "manual" | "auto"; account?: `0x${string}` } = {}) {
  const account = (options.account ?? alice.address).toLowerCase();
  const signer = account === alice.address.toLowerCase() ? alice : external;
  const envelope: Envelope = {
    version: "mandate/2",
    caps,
    assets: [...ASSETS.slice(0, 1)],
    quote: USDC,
    venue: "aerodrome",
  };
  const now = new Date();
  const artifact = randomBytes(32).toString("hex");
  const message = `Mandate strategy authorization\nArtifact: ${artifact}\nAccount: ${account}`;
  await repo.saveDraft({
    id: randomUUID(),
    userId: user,
    account,
    artifactId: artifact,
    name: "AAPL entry",
    mode: options.mode ?? "auto",
    plan,
    envelope,
    reading: "Structured plan supplied by the user.",
    renderText: "Buy 10 USDC of AAPLc when it trades under 300.",
    renderHash: randomBytes(32).toString("hex"),
    confirmMessage: message,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 1_800_000),
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers: { ...headers, "x-mandate-wallet": account },
    payload: { artifact_id: artifact, signature: await signer.signMessage({ message }) },
  });
  expect(response.statusCode).toBe(201);
  return response.json<{ instance: string; mode: string }>().instance;
}

async function row(instance: string): Promise<InstanceRow> {
  const found = await tenant(database, user, async (tx) => {
    const [record] = await tx
      .select()
      .from(schema.instances)
      .where(eq(schema.instances.id, instance));
    return record;
  });
  if (!found) throw new Error("instance row missing");
  return found;
}

const toggle = (wallet: string, auth = headers) =>
  app.inject({ method: "POST", url: "/v1/me/automation", headers: auth, payload: { wallet } });
const arm = (instance: string) =>
  app.inject({
    method: "POST",
    url: `/v1/instances/${instance}/arm`,
    headers: { ...headers, "x-mandate-wallet": alice.address },
  });

test("a delegated wallet turns every automatic strategy it signed to auto, and nothing else", async () => {
  const wanted = await createInstance({ mode: "auto" });
  const manual = await createInstance({ mode: "manual" });
  const other = await createInstance({ mode: "auto", account: external.address });
  const halted = await createInstance({ mode: "auto" });
  await app.inject({ method: "POST", url: `/v1/instances/${halted}/kill`, headers });
  expect((await row(wanted)).mode).toBe("manual");

  delegated.add(alice.address.toLowerCase());
  const response = await toggle(alice.address);
  expect(response.statusCode).toBe(200);
  expect(response.json<Record<string, unknown>>()).toEqual({
    wallet: alice.address.toLowerCase(),
    delegated: true,
    signer_id: SIGNER,
  });
  expect((await row(wanted)).mode).toBe("auto");
  // Auto mode is consent to sign, not a decision to run: the instance stays paused.
  expect((await row(wanted)).status).toBe("paused");
  // A manual draft never asked; another wallet's draft is another wallet's consent; a halted
  // instance is over, and setMode would refuse to touch it.
  expect((await row(manual)).mode).toBe("manual");
  expect((await row(other)).mode).toBe("manual");
  expect((await row(halted)).mode).toBe("manual");
  expect((await row(halted)).status).toBe("halted");

  // Idempotent: asking again with nothing changed writes nothing.
  const before = (await row(wanted)).updatedAt.getTime();
  expect((await toggle(alice.address)).statusCode).toBe(200);
  expect((await row(wanted)).updatedAt.getTime()).toBe(before);
});

test("withdrawing the delegation turns the wallet's automatic strategies manual and pauses the armed ones", async () => {
  delegated.add(alice.address.toLowerCase());
  const armed = await createInstance({ mode: "auto" });
  const paused = await createInstance({ mode: "auto" });
  expect((await arm(armed)).json<{ status: string; mode: string }>()).toMatchObject({
    status: "armed",
    mode: "auto",
  });
  expect((await row(paused)).mode).toBe("auto");

  delegated.clear();
  const response = await toggle(alice.address);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ delegated: false, signer_id: SIGNER });
  // An armed rule the worker can no longer sign for must not stay armed: it would evaluate,
  // admit orders, and fail every one of them at Privy.
  expect(await row(armed)).toMatchObject({ mode: "manual", status: "paused" });
  expect(await row(paused)).toMatchObject({ mode: "manual", status: "paused" });

  // And arming again needs the delegation back.
  const refused = await arm(armed);
  expect(refused.statusCode).toBe(409);
  expect(refused.json<{ code: string }>().code).toBe("automation-required");
});

test("a wallet the user has not linked is 403, and an unauthenticated caller is 401", async () => {
  const unlinked = await toggle(mallory.address);
  expect(unlinked.statusCode).toBe(403);
  expect(unlinked.json<{ code: string }>().code).toBe("wallet-not-linked");
  // The address must not be echoed: it was never verified for this account.
  expect(unlinked.body.toLowerCase()).not.toContain(mallory.address.slice(2).toLowerCase());
  expect((await toggle(alice.address, { authorization: "Bearer nobody" })).statusCode).toBe(401);
  // A linked wallet that is not embedded is simply not delegated; nothing to flip.
  const linked = await toggle(external.address);
  expect(linked.statusCode).toBe(200);
  expect(linked.json()).toMatchObject({ wallet: external.address.toLowerCase(), delegated: false });
});

test("a body that is not a wallet address is 400", async () => {
  expect((await toggle("not-an-address")).statusCode).toBe(400);
  const extra = await app.inject({
    method: "POST",
    url: "/v1/me/automation",
    headers,
    payload: { wallet: alice.address, user_id: "attacker" },
  });
  expect(extra.statusCode).toBe(400);
});

test("without a configured signer the route answers 409 and touches nothing", async () => {
  const unsupported = await harness(settings({ PRIVY_KEY_QUORUM_ID: undefined }));
  delegated.add(alice.address.toLowerCase());
  const instance = await createInstance({ mode: "auto" });
  const response = await unsupported.inject({
    method: "POST",
    url: "/v1/me/automation",
    headers,
    payload: { wallet: alice.address },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json<{ code: string }>().code).toBe("automation-unsupported");
  // Created through the app with a signer, so it went auto; the unsupported app leaves it be.
  expect((await row(instance)).mode).toBe("auto");
});

test("an unreachable Privy is 503 and no mode moves", async () => {
  delegated.add(alice.address.toLowerCase());
  const instance = await createInstance({ mode: "auto" });
  expect((await arm(instance)).statusCode).toBe(200);
  privyDown = true;
  const response = await toggle(alice.address);
  expect(response.statusCode).toBe(503);
  expect(response.json<{ code: string }>().code).toBe("unavailable");
  expect(response.body).not.toContain("privy.io");
  // "Not delegated" would have been a guess, and the guess pauses a strategy the user did not
  // pause. The row is exactly as it was.
  expect(await row(instance)).toMatchObject({ mode: "auto", status: "armed" });
});
