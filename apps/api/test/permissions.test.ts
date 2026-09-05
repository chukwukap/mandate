import { afterAll, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { type Config, loadConfig } from "@mandate/config";
import {
  type Asset,
  type ChainReader,
  type Hex,
  type PermissionPayload,
  Problem,
} from "@mandate/contracts";
import { connectDatabase, type Database, Repository, schema } from "@mandate/database";
import { ASSETS, permissionHash, permissionTypedData, SPEND_MANAGER, USDC } from "@mandate/evm";
import type { Caps, Envelope, Plan } from "@mandate/strategy";
import { units } from "@mandate/strategy";
import { drizzle } from "drizzle-orm/pglite";
import { verifyMessage, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../src/app.js";
import {
  permissionEnd,
  registerPermissions,
  requiresSellAuthority,
} from "../src/modules/permissions/index.js";

const alice = privateKeyToAccount(`0x${"11".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"22".repeat(32)}`);
const spender = `0x${"33".repeat(20)}` as Hex;
function catalogueAsset(symbol: string): Asset {
  const found = ASSETS.find((a) => a.symbol === symbol);
  if (!found) throw new Error(`${symbol} is missing from the catalogue`);
  return found;
}
const asset = catalogueAsset("AAPLc");

const nativeUrl = process.env.TEST_DATABASE_URL;
const pglite = nativeUrl ? undefined : new PGlite();
const native = nativeUrl ? connectDatabase(nativeUrl) : undefined;
let repository: Repository;
let app: Awaited<ReturnType<typeof buildApp>>;
let ineligibleApp: Awaited<ReturnType<typeof buildApp>>;

// Chain state the tests drive. `fail` injects transport failures: viem returns false for a bad
// signature but throws when the RPC is unreachable, and those two must not land on the same
// status code.
const chainState = {
  approved: false,
  revoked: false,
  walletKind: "base_account" as "eoa" | "base_account" | "contract",
  fail: { walletKind: false, verifyPermission: false, permissionStatus: false },
};
function rpcDown(): never {
  // Shaped like a real viem transport error, whose message carries the provider URL and key.
  throw new Error("HttpRequestError: POST https://mainnet.base.org/v1/KEY-SHOULD-NOT-LEAK failed");
}
const chain: ChainReader = {
  ready: async () => true,
  market: async () => [],
  quote: async () => {
    throw Problem.unavailable("No route");
  },
  walletKind: async () => (chainState.fail.walletKind ? rpcDown() : chainState.walletKind),
  permissionStatus: async () =>
    chainState.fail.permissionStatus
      ? rpcDown()
      : { approved: chainState.approved, revoked: chainState.revoked },
  verifyMessage: (address, message, signature) => verifyMessage({ address, message, signature }),
  verifyPermission: async (payload, signature) =>
    chainState.fail.verifyPermission
      ? rpcDown()
      : verifyTypedData({ address: payload.account, ...permissionTypedData(payload), signature }),
};

function planFor(side: "buy" | "sell"): Plan {
  return {
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
        id: "hold",
        scope: "portfolio",
        initial: "idle",
        states: [{ id: "idle", transitions: [] }],
      },
      {
        id: side,
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
                  { action: "notify", message: "signal" },
                  { action: "order", asset: 0, side, size: { unit: "quote", value: "10" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
const buyPlan = planFor("buy");
const sellPlan = planFor("sell");

/** Expiry deliberately carries a non-zero millisecond component so floor vs ceil is observable. */
function capsAt(now: number): Caps {
  return {
    lifetime: "100",
    per_order: "10",
    per_period: "20.5",
    period_secs: 86400,
    max_orders_per_period: 2,
    cooldown_secs: 60,
    expires_at: new Date(Math.floor(now / 1000) * 1000 + 750 + 86400_000).toISOString(),
    slippage_bps: 50,
  };
}

function makeConfig(devCountry?: string): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://test:test@localhost/test",
    PRIVY_APP_ID: "test",
    PRIVY_APP_SECRET: "test",
    LOG_LEVEL: "silent",
    ELIGIBLE_COUNTRIES: "GB",
    SPENDER_ADDRESS: spender,
    ...(devCountry ? { DEV_COUNTRY: devCountry } : {}),
  });
}
async function makeApp(config: Config) {
  const built = await buildApp({
    config,
    auth: {
      authenticate: async (header) => {
        const account = header === "Bearer alice" ? alice : header === "Bearer bob" ? bob : null;
        if (!account) throw Problem.unauthenticated();
        return {
          privyDid: account === alice ? "did:privy:alice" : "did:privy:bob",
          sessionId: "session",
          wallets: [account.address.toLowerCase() as Hex],
        };
      },
    },
    users: repository,
    databaseReady: async () => true,
    chainReady: chain.ready,
  });
  // Registered directly rather than through ApiDependencies: this suite exercises the module in
  // isolation and cannot collide with whichever key app.ts ends up wiring it under.
  await registerPermissions(built, config, { repository, chain });
  return built;
}

beforeAll(async () => {
  if (pglite) {
    const dir = new URL("../../../packages/database/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort())
      await pglite.exec(await readFile(new URL(file, dir), "utf8"));
    await pglite.exec(
      "create role api_test nologin; grant usage on schema mandate_v2 to api_test; grant select,insert,update,delete on all tables in schema mandate_v2 to api_test; set role api_test",
    );
  }
  const database = pglite ? (drizzle(pglite, { schema }) as unknown as Database) : native?.db;
  if (!database) throw new Error("Test database is missing");
  repository = new Repository(database);
  app = await makeApp(makeConfig("GB"));
  ineligibleApp = await makeApp(makeConfig());
}, 30000);
afterAll(async () => {
  await app?.close();
  await ineligibleApp?.close();
  await pglite?.close();
  await native?.close();
});
beforeEach(() => {
  chainState.approved = false;
  chainState.revoked = false;
  chainState.walletKind = "base_account";
  chainState.fail = { walletKind: false, verifyPermission: false, permissionStatus: false };
});

type View = {
  id: string;
  instance: string;
  status: string;
  typed_data: { message: PermissionPayload };
  hash: Hex;
  spender: string;
  allowance: string;
  token: string;
  period_secs: number;
  expires_at: string;
  execution_available: boolean;
  approval_call?: { to: string; data: string; value: string; chain_id: number };
};

/**
 * Seeds a signed strategy straight through the repository. Going through /v1/strategies would
 * couple this suite to the strategies module, which is being split apart in parallel.
 */
async function seed(
  options: { mode?: "manual" | "auto"; plan?: Plan; signer?: typeof alice } = {},
) {
  const signer = options.signer ?? alice;
  const account = signer.address.toLowerCase();
  const user = (
    await repository.resolvePrivyUser(`did:privy:${signer === alice ? "alice" : "bob"}`)
  ).id;
  const now = new Date();
  const caps = capsAt(now.getTime());
  const envelope: Envelope = {
    version: "mandate/2",
    caps,
    assets: [asset],
    quote: USDC,
    venue: "aerodrome",
  };
  const artifactId = randomBytes(32).toString("hex");
  const id = randomUUID();
  await repository.saveDraft({
    id,
    userId: user,
    account,
    artifactId,
    name: "AAPL entry",
    mode: options.mode ?? "auto",
    plan: options.plan ?? buyPlan,
    envelope,
    reading: "Seeded review",
    renderText: "Seeded review text",
    renderHash: "0".repeat(64),
    confirmMessage: "Seeded confirmation",
    createdAt: now,
    expiresAt: new Date(now.getTime() + 1800_000),
  });
  const draft = await repository.draft(user, artifactId);
  if (!draft) throw new Error("Seeded draft missing");
  const instance = await repository.createInstance(
    user,
    draft,
    `0x${"ab".repeat(32)}`,
    draft.name,
    12000,
    now,
  );
  return { instance: instance.id, user, account, caps };
}

const headers = { authorization: "Bearer alice" };
const prepare = (instance: string, on = app) =>
  on.inject({ method: "POST", url: "/v1/permissions/prepare", headers, payload: { instance } });
const submit = (instance: string, signature: string, on = app) =>
  on.inject({ method: "POST", url: "/v1/permissions", headers, payload: { instance, signature } });
const read = (instance: string, on = app) =>
  on.inject({ url: `/v1/instances/${instance}/permission`, headers });
const activate = (instance: string, enable = true, on = app) =>
  on.inject({
    method: "POST",
    url: `/v1/instances/${instance}/permission/activate`,
    headers,
    payload: { enable_auto: enable },
  });
const revoke = (instance: string, on = app) =>
  on.inject({ method: "POST", url: `/v1/instances/${instance}/permission/revoke`, headers });

test("a permission prepared and submitted across a second boundary still verifies", async () => {
  const { instance } = await seed();
  const real = Date.now();
  // Land on the last millisecond of a second, then step over it.
  const frozen = real - (real % 1000) + 999;
  try {
    setSystemTime(new Date(frozen));
    const first = await prepare(instance);
    expect(first.statusCode).toBe(200);
    const view = first.json<View>();
    const payload = view.typed_data.message;
    expect(payload.start).toBe(Math.floor(frozen / 1000));

    setSystemTime(new Date(frozen + 2));
    // Proof the boundary really moved: a handler that rebuilt the payload would now compute a
    // different `start`, and therefore a different EIP-712 digest.
    const rebuiltStart = Math.floor((frozen + 2) / 1000);
    expect(rebuiltStart).not.toBe(payload.start);
    expect(permissionHash({ ...payload, start: rebuiltStart })).not.toBe(view.hash);

    const again = (await prepare(instance)).json<View>();
    expect(again.typed_data.message).toEqual(payload);
    expect(again.hash).toBe(view.hash);

    // Negative control: the digest a rebuilding server would have verified against is rejected.
    const wrong = await alice.signTypedData(
      permissionTypedData({ ...payload, start: rebuiltStart }),
    );
    const rejected = await submit(instance, wrong);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ code: string }>().code).toBe("invalid-signature");

    const signature = await alice.signTypedData(permissionTypedData(payload));
    const accepted = await submit(instance, signature);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<View>().status).toBe("signed");
    expect(accepted.json<View>().typed_data.message).toEqual(payload);
  } finally {
    setSystemTime();
  }
});

test("the stored payload satisfies every equality the worker revalidates before executing", async () => {
  const { instance, account, caps } = await seed();
  const view = (await prepare(instance)).json<View>();
  const p = view.typed_data.message;
  const now = Math.floor(Date.now() / 1000);
  expect(p.account.toLowerCase()).toBe(account);
  expect(p.spender.toLowerCase()).toBe(spender.toLowerCase());
  expect(p.token.toLowerCase()).toBe(USDC.toLowerCase());
  expect(p.allowance).toBe(units(caps.per_period, 6).toString());
  expect(p.period).toBe(caps.period_secs);
  expect(p.end).toBe(Math.floor(Date.parse(caps.expires_at) / 1000));
  // Strictly less, because the expiry carries 750ms: Math.ceil here would put `end` past the
  // signed cap and the worker would refuse every execution with "Permission mismatch".
  expect(p.end * 1000).toBeLessThan(Date.parse(caps.expires_at));
  expect(p.start).toBeLessThanOrEqual(now);
  expect(p.end).toBeGreaterThan(now);
  expect(permissionHash(p)).toBe(view.hash);
  expect(p.extraData).toBe("0x");
  expect(BigInt(p.salt)).toBeGreaterThan(0n);
  expect(BigInt(p.allowance)).toBeLessThan(2n ** 160n);
});

test("chain transport failures read as 503 and never as an invalid signature", async () => {
  const { instance, user } = await seed();
  chainState.fail.walletKind = true;
  const blocked = await prepare(instance);
  expect(blocked.statusCode).toBe(503);
  expect(blocked.json<{ code: string; detail: string }>().code).toBe("unavailable");
  expect(blocked.json<{ detail: string }>().detail).not.toContain("KEY-SHOULD-NOT-LEAK");
  // Nothing was stored, so a later retry still gets a fresh payload rather than a dead row.
  expect((await read(instance)).statusCode).toBe(404);

  chainState.fail.walletKind = false;
  const view = (await prepare(instance)).json<View>();
  const signature = await alice.signTypedData(permissionTypedData(view.typed_data.message));
  chainState.fail.verifyPermission = true;
  const unreachable = await submit(instance, signature);
  expect(unreachable.statusCode).toBe(503);
  expect(unreachable.json<{ code: string }>().code).not.toBe("invalid-signature");
  chainState.fail.verifyPermission = false;
  expect((await submit(instance, signature)).statusCode).toBe(200);

  chainState.fail.permissionStatus = true;
  expect((await activate(instance)).statusCode).toBe(503);
  // Revoke pauses locally before it reads the chain: a failed read still stops the strategy.
  await repository.transition(user, instance, "arm", new Date());
  expect((await revoke(instance)).statusCode).toBe(503);
  expect((await repository.detail(user, instance)).instance.status).toBe("paused");
});

test("activation follows observed chain state and revocation is idempotent", async () => {
  const { instance, user } = await seed();
  const view = (await prepare(instance)).json<View>();
  expect(view.status).toBe("prepared");
  expect(view.approval_call).toBeUndefined();
  const signature = await alice.signTypedData(permissionTypedData(view.typed_data.message));
  expect((await submit(instance, signature)).json<View>().approval_call?.to).toBe(SPEND_MANAGER);
  // Re-submitting the identical signature is idempotent, not a conflict.
  expect((await submit(instance, signature)).statusCode).toBe(200);

  const pending = await activate(instance);
  expect(pending.statusCode).toBe(409);
  expect(pending.json<{ code: string }>().code).toBe("approval-pending");
  chainState.approved = true;
  expect((await activate(instance)).json<View>().status).toBe("active");
  expect((await repository.detail(user, instance)).instance.mode).toBe("auto");

  const first = await revoke(instance);
  expect(first.json<{ onchain_revocation_required: boolean }>().onchain_revocation_required).toBe(
    true,
  );
  expect((await repository.detail(user, instance)).instance.mode).toBe("auto");
  chainState.revoked = true;
  for (const _ of [0, 1]) {
    const done = await revoke(instance);
    expect(done.json<View>().status).toBe("revoked");
    expect(done.json<{ onchain_revocation_required: boolean }>().onchain_revocation_required).toBe(
      false,
    );
  }
  expect((await repository.detail(user, instance)).instance.mode).toBe("manual");
});

test("revocation stays open to an ineligible caller while preparation does not", async () => {
  const { instance } = await seed();
  await prepare(instance);
  const refused = await prepare(instance, ineligibleApp);
  expect(refused.statusCode).toBe(403);
  expect(refused.json<{ code: string }>().code).toBe("not-eligible");
  expect((await activate(instance, true, ineligibleApp)).statusCode).toBe(403);

  const withdrawn = await revoke(instance, ineligibleApp);
  expect(withdrawn.statusCode).toBe(200);
  const body = withdrawn.json<{
    revocation_call: { to: string; data: string };
    revoke_call: { to: string; data: string };
    account: string;
    onchain_revocation_required: boolean;
  }>();
  expect(body.onchain_revocation_required).toBe(true);
  expect(body.revocation_call.to).toBe(SPEND_MANAGER);
  expect(body.revoke_call).toEqual(body.revocation_call);
  expect(body.account.toLowerCase()).toBe(alice.address.toLowerCase());
});

test("every permission route is scoped to the owner", async () => {
  const { instance } = await seed();
  const view = (await prepare(instance)).json<View>();
  const signature = await alice.signTypedData(permissionTypedData(view.typed_data.message));
  const intruder = { authorization: "Bearer bob" };
  const calls = [
    { method: "POST" as const, url: "/v1/permissions/prepare", payload: { instance } },
    { method: "POST" as const, url: "/v1/permissions", payload: { instance, signature } },
    { method: "GET" as const, url: `/v1/instances/${instance}/permission` },
    {
      method: "POST" as const,
      url: `/v1/instances/${instance}/permission/activate`,
      payload: { enable_auto: true },
    },
    { method: "POST" as const, url: `/v1/instances/${instance}/permission/revoke` },
  ];
  for (const call of calls)
    expect((await app.inject({ ...call, headers: intruder })).statusCode).toBe(404);
  // The owner's permission is untouched by the attempts.
  expect((await read(instance)).json<View>().hash).toBe(view.hash);
});

test("a wallet the caller did not sign with cannot prepare or submit", async () => {
  const { instance } = await seed();
  const mismatched = { ...headers, "x-mandate-wallet": bob.address.toLowerCase() };
  const refused = await app.inject({
    method: "POST",
    url: "/v1/permissions/prepare",
    headers: mismatched,
    payload: { instance },
  });
  // Bob's address is not linked to Alice's Privy account at all, so wallet selection fails first.
  expect(refused.statusCode).toBe(403);
  expect((await read(instance)).statusCode).toBe(404);
});

test("unauthorizable strategies are refused before any permission row exists", async () => {
  const manual = await seed({ mode: "manual" });
  const refusedManual = await prepare(manual.instance);
  expect(refusedManual.statusCode).toBe(409);
  expect(refusedManual.json<{ code: string }>().code).toBe("manual-strategy");

  const sell = await seed({ plan: sellPlan });
  const refusedSell = await prepare(sell.instance);
  expect(refusedSell.statusCode).toBe(409);
  expect(refusedSell.json<{ code: string }>().code).toBe("sell-permission-required");

  const eoa = await seed();
  chainState.walletKind = "eoa";
  const refusedWallet = await prepare(eoa.instance);
  expect(refusedWallet.statusCode).toBe(409);
  expect(refusedWallet.json<{ code: string }>().code).toBe("wallet-unsupported");

  for (const { instance } of [manual, sell, eoa])
    expect((await read(instance)).statusCode).toBe(404);
});

test("the response keeps the exact shape the web client and docs depend on", async () => {
  const { instance } = await seed();
  const prepareResponse = await prepare(instance);
  expect(Object.keys(prepareResponse.json<View>()).sort()).toEqual([
    "allowance",
    "execution_available",
    "expires_at",
    "hash",
    "id",
    "instance",
    "period_secs",
    "spender",
    "status",
    "token",
    "typed_data",
  ]);
  const view = prepareResponse.json<View>();
  expect(view.expires_at).toBe(new Date(view.typed_data.message.end * 1000).toISOString());
  expect(view.allowance).toBe(view.typed_data.message.allowance);
  expect(view.period_secs).toBe(view.typed_data.message.period);
  const typed = prepareResponse.json<{
    typed_data: { domain: { chainId: number; verifyingContract: string }; primaryType: string };
  }>().typed_data;
  expect(typed.domain.chainId).toBe(8453);
  expect(typed.domain.verifyingContract).toBe(SPEND_MANAGER);
  expect(typed.primaryType).toBe("SpendPermission");

  const signature = await alice.signTypedData(permissionTypedData(view.typed_data.message));
  const submitted = await submit(instance, signature);
  expect(Object.keys(submitted.json<View>()).sort()).toEqual([
    "allowance",
    "approval_call",
    "execution_available",
    "expires_at",
    "hash",
    "id",
    "instance",
    "onchain_approval_required",
    "period_secs",
    "spender",
    "status",
    "token",
    "typed_data",
  ]);
});

test("end is floored from the signed expiry and sell authority is detected anywhere in the plan", () => {
  expect(permissionEnd("2030-01-01T00:00:00.999Z")).toBe(Date.parse("2030-01-01T00:00:00Z") / 1000);
  expect(permissionEnd("2030-01-01T00:00:00.000Z")).toBe(Date.parse("2030-01-01T00:00:00Z") / 1000);
  expect(() => permissionEnd("not a date")).toThrow(Problem);
  expect(requiresSellAuthority(buyPlan)).toBe(false);
  // The sell action is the second action of the second machine's only transition: a scan that
  // stopped at the first action, or only looked at the first machine, would miss it.
  expect(requiresSellAuthority(sellPlan)).toBe(true);
});
