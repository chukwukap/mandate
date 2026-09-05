import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { loadConfig } from "@mandate/config";
import { type ChainReader, type Hex, Problem } from "@mandate/contracts";
import { connectDatabase, type Database, Repository, schema } from "@mandate/database";
import { ASSETS, permissionTypedData } from "@mandate/evm";
import { drizzle } from "drizzle-orm/pglite";
import { verifyMessage, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../src/app.js";

const alice = privateKeyToAccount(`0x${"11".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"22".repeat(32)}`);
const nativeUrl = process.env.TEST_DATABASE_URL;
const db = nativeUrl ? undefined : new PGlite();
const native = nativeUrl ? connectDatabase(nativeUrl) : undefined;
let app: Awaited<ReturnType<typeof buildApp>>;
let approved = false;
let revoked = false;
const chain: ChainReader = {
  ready: async () => true,
  market: async () => [],
  quote: async () => {
    throw Problem.unavailable("No route");
  },
  walletKind: async () => "base_account",
  permissionStatus: async () => ({ approved, revoked }),
  verifyMessage: (address, message, signature) => verifyMessage({ address, message, signature }),
  verifyPermission: (payload, signature) =>
    verifyTypedData({ address: payload.account, ...permissionTypedData(payload), signature }),
};
const plan = {
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
};
const caps = {
  lifetime: "100",
  per_order: "10",
  per_period: "20",
  period_secs: 86400,
  max_orders_per_period: 2,
  cooldown_secs: 60,
  expires_at: new Date(Date.now() + 86400_000).toISOString(),
  slippage_bps: 50,
};
beforeAll(async () => {
  if (db) {
    const dir = new URL("../../../packages/database/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort())
      await db.exec(await readFile(new URL(file, dir), "utf8"));
    await db.exec(
      "create role api_test nologin; grant usage on schema mandate_v2 to api_test; grant select,insert,update,delete on all tables in schema mandate_v2 to api_test; set role api_test",
    );
  }
  const database = db ? (drizzle(db, { schema }) as unknown as Database) : native?.db;
  if (!database) throw new Error("Test database is missing");
  const repository = new Repository(database);
  app = await buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test:test@localhost/test",
      PRIVY_APP_ID: "test",
      PRIVY_APP_SECRET: "test",
      LOG_LEVEL: "silent",
      DEV_COUNTRY: "GB",
      ELIGIBLE_COUNTRIES: "GB",
      SPENDER_ADDRESS: `0x${"33".repeat(20)}`,
    }),
    auth: {
      authenticate: async (header) => {
        const user = header === "Bearer alice" ? alice : header === "Bearer bob" ? bob : undefined;
        if (!user) throw Problem.unauthenticated();
        return {
          privyDid: header === "Bearer alice" ? "did:privy:alice" : "did:privy:bob",
          sessionId: "session",
          wallets: [user.address.toLowerCase() as Hex],
        };
      },
    },
    users: repository,
    databaseReady: async () => true,
    chainReady: chain.ready,
    trading: { repository, chain, assets: ASSETS },
  });
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.close();
  await native?.close();
});
const headers = { authorization: "Bearer alice" };
async function draft() {
  const r = await app.inject({
    method: "POST",
    url: "/v1/strategies/draft",
    headers,
    payload: { name: "AAPL entry", mode: "auto", plan, caps, assets: ["AAPLc"] },
  });
  expect(r.statusCode).toBe(201);
  return r.json<{ artifact_id: string; confirm_message: string }>();
}
async function create() {
  const d = await draft();
  const signature = await alice.signMessage({ message: d.confirm_message });
  const r = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: d.artifact_id, signature },
  });
  expect(r.statusCode).toBe(201);
  return { ...d, signature, instance: r.json<{ instance: string }>().instance };
}
test("exact signed content is required and drafts cannot be consumed twice", async () => {
  const d = await draft();
  const badSignature = await alice.signMessage({ message: `${d.confirm_message} altered` });
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/strategies",
        headers,
        payload: { artifact_id: d.artifact_id, signature: badSignature },
      })
    ).statusCode,
  ).toBe(400);
  const signature = await alice.signMessage({ message: d.confirm_message });
  const args = {
    method: "POST" as const,
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: d.artifact_id, signature },
  };
  expect((await app.inject(args)).statusCode).toBe(201);
  expect((await app.inject(args)).statusCode).toBe(409);
});
test("cross-user access is denied for detail, history and lifecycle", async () => {
  const { instance } = await create();
  const headers = { authorization: "Bearer bob" };
  for (const tail of ["", "/executions", "/evaluations"])
    expect(
      (await app.inject({ url: `/v1/instances/${instance}${tail}`, headers })).statusCode,
    ).toBe(404);
  expect(
    (await app.inject({ method: "POST", url: `/v1/instances/${instance}/kill`, headers }))
      .statusCode,
  ).toBe(404);
  const list = await app.inject({ url: "/v1/instances", headers });
  expect(list.json<{ items: unknown[] }>().items).toHaveLength(0);
});
test("permission payload is stable; activation and revocation reflect actual chain state", async () => {
  const { instance } = await create();
  const prepare = () =>
    app.inject({ method: "POST", url: "/v1/permissions/prepare", headers, payload: { instance } });
  const first = await prepare();
  expect(first.statusCode).toBe(200);
  const persisted = first.json<{
    hash: string;
    typed_data: { message: Parameters<typeof permissionTypedData>[0] };
  }>();
  expect((await prepare()).json<{ hash: string }>().hash).toBe(persisted.hash);
  const signature = await alice.signTypedData(permissionTypedData(persisted.typed_data.message));
  const saved = await app.inject({
    method: "POST",
    url: "/v1/permissions",
    headers,
    payload: { instance, signature },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json<{ status: string }>().status).toBe("signed");
  expect((await prepare()).json<{ approval_call: unknown }>().approval_call).toEqual(
    saved.json<{ approval_call: unknown }>().approval_call,
  );
  expect(
    (await app.inject({ url: `/v1/instances/${instance}`, headers })).json<{
      requested_mode: string;
    }>().requested_mode,
  ).toBe("auto");
  const activate = () =>
    app.inject({
      method: "POST",
      url: `/v1/instances/${instance}/permission/activate`,
      headers,
      payload: { enable_auto: true },
    });
  expect((await activate()).statusCode).toBe(409);
  approved = true;
  expect((await activate()).json<{ status: string }>().status).toBe("active");
  const arm = await app.inject({ method: "POST", url: `/v1/instances/${instance}/arm`, headers });
  expect(arm.json<{ mode: string }>().mode).toBe("auto");
  expect(arm.json<{ status: string }>().status).toBe("armed");
  const revoke = () =>
    app.inject({ method: "POST", url: `/v1/instances/${instance}/permission/revoke`, headers });
  expect(
    (await revoke()).json<{ onchain_revocation_required: boolean }>().onchain_revocation_required,
  ).toBe(true);
  revoked = true;
  const done = await revoke();
  expect(done.json<{ status: string }>().status).toBe("revoked");
  expect(done.json<{ onchain_revocation_required: boolean }>().onchain_revocation_required).toBe(
    false,
  );
  approved = false;
  revoked = false;
});
test("terminal instances cannot rearm and missing execution history is an empty list", async () => {
  const { instance } = await create();
  expect(
    (await app.inject({ method: "POST", url: `/v1/instances/${instance}/kill`, headers }))
      .statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ method: "POST", url: `/v1/instances/${instance}/arm`, headers }))
      .statusCode,
  ).toBe(409);
  expect(
    (await app.inject({ url: `/v1/instances/${instance}/executions`, headers })).json<{
      items: unknown[];
    }>().items,
  ).toHaveLength(0);
});
test("invalid pagination and unsolicited identity fields are rejected", async () => {
  expect((await app.inject({ url: "/v1/instances?limit=999", headers })).statusCode).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/strategies/draft",
        headers,
        payload: { plan, caps, assets: ["AAPLc"], user_id: "attacker" },
      })
    ).statusCode,
  ).toBe(400);
});

test("permission timestamps remain stable after a two-minute signing delay", async () => {
  const { instance } = await create();
  const prepare = () =>
    app.inject({ method: "POST", url: "/v1/permissions/prepare", headers, payload: { instance } });
  const first = await prepare();
  const original = first.json<{
    hash: string;
    typed_data: { message: Parameters<typeof permissionTypedData>[0] };
  }>();
  try {
    setSystemTime(new Date(Date.now() + 120000));
    expect((await prepare()).json<{ hash: string }>().hash).toBe(original.hash);
    const changed = {
      ...original.typed_data.message,
      start: original.typed_data.message.start + 120,
    };
    const wrong = await alice.signTypedData(permissionTypedData(changed));
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/permissions",
          headers,
          payload: { instance, signature: wrong },
        })
      ).statusCode,
    ).toBe(400);
    const signature = await alice.signTypedData(permissionTypedData(original.typed_data.message));
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/permissions",
          headers,
          payload: { instance, signature },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    setSystemTime();
  }
});

test("pagination retains every instance when creation timestamps are equal", async () => {
  try {
    setSystemTime(new Date(Date.now() + 300000));
    const first = await create();
    const second = await create();
    type Page = {
      items: { id: string }[];
      next_page: { before: string; before_id: string } | null;
    };
    const a = (await app.inject({ url: "/v1/instances?limit=1", headers })).json<Page>();
    if (!a.next_page) throw new Error("Missing cursor");
    const query = new URLSearchParams({ limit: "1", ...a.next_page });
    const b = (await app.inject({ url: `/v1/instances?${query}`, headers })).json<Page>();
    expect(new Set([a.items[0]?.id, b.items[0]?.id])).toEqual(
      new Set([first.instance, second.instance]),
    );
  } finally {
    setSystemTime();
  }
});
