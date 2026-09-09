import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { loadConfig } from "@mandate/config";
import { type ChainReader, type Hex, Problem } from "@mandate/contracts";
import { connectDatabase, type Database, Repository, schema } from "@mandate/database";
import { ASSETS } from "@mandate/evm";
import { drizzle } from "drizzle-orm/pglite";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../src/app.js";

const alice = privateKeyToAccount(`0x${"11".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"22".repeat(32)}`);
const nativeUrl = process.env.TEST_DATABASE_URL;
const db = nativeUrl ? undefined : new PGlite();
const native = nativeUrl ? connectDatabase(nativeUrl) : undefined;
let app: Awaited<ReturnType<typeof buildApp>>;
const chain: ChainReader = {
  ready: async () => true,
  market: async () => [],
  quote: async () => {
    throw Problem.unavailable("No route");
  },
  verifyMessage: (address, message, signature) => verifyMessage({ address, message, signature }),
};
/** Alice's wallet is embedded and delegated; Bob's is an external wallet Privy cannot sign for. */
const delegated = new Set<string>([alice.address.toLowerCase()]);
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
      PRIVY_KEY_QUORUM_ID: "kq_test",
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
    wallets: {
      embedded: async (_did, address) =>
        delegated.has(address.toLowerCase())
          ? { id: "wallet-alice", address: address.toLowerCase() as Hex, delegated: true }
          : null,
    },
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
/**
 * A basket, end to end, in the shape the structured builder emits: one machine per asset, each
 * buying the asset at its own index. The index is the whole hazard — a plan whose machines and
 * whose signed asset list drift apart still validates, still signs, and then buys a different
 * company than the one whose price triggered it.
 */
test("a multi-asset strategy signs and arms, with the index mapping inside the signed text", async () => {
  const symbols = ["AAPLc", "NVDAc", "TSLAc"];
  const prices = ["300", "150", "250"];
  const basket = {
    params: [],
    nodes: symbols.map((symbol, index) => ({
      id: `target_${symbol}`,
      op: "lt",
      args: [
        { kind: "feed", feed: `oracle:${symbol}` },
        { kind: "const", value: prices[index] },
      ],
    })),
    machines: symbols.map((symbol, index) => ({
      id: `entry_${symbol}`,
      scope: "portfolio",
      initial: "watching",
      states: [
        {
          id: "watching",
          transitions: [
            {
              when: `target_${symbol}`,
              to: "watching",
              actions: [
                {
                  action: "order",
                  asset: index,
                  side: "buy",
                  size: { unit: "quote", value: "10" },
                },
              ],
            },
          ],
        },
      ],
    })),
  };
  const drafted = await app.inject({
    method: "POST",
    url: "/v1/strategies/draft",
    headers,
    payload: { name: "Three stocks", mode: "auto", plan: basket, caps, assets: symbols },
  });
  expect(drafted.statusCode).toBe(201);
  const body = drafted.json<{
    artifact_id: string;
    confirm_message: string;
    render_text: string;
    card: { rules: string[]; cautions: string[] };
  }>();

  // Each rule names the company it buys, resolved through the signed asset list rather than
  // repeated from the plan — this is what makes an index error visible before signing.
  expect(body.card.rules).toHaveLength(3);
  for (const symbol of symbols) expect(body.card.rules.join("\n")).toContain(`of ${symbol}`);

  // The two multi-asset disclosures, and both inside the text the signature covers.
  const cautions = body.card.cautions.join("\n");
  expect(cautions).toContain("0=AAPLc, 1=NVDAc, 2=TSLAc");
  expect(cautions).toContain("3 rules can trigger in the same evaluation");
  for (const caution of body.card.cautions) expect(body.render_text).toContain(caution);

  const signature = await alice.signMessage({ message: body.confirm_message });
  const created = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: { artifact_id: body.artifact_id, signature },
  });
  expect(created.statusCode).toBe(201);

  // Armed and readable back with all three assets intact, in the order signed.
  const instance = created.json<{ instance: string }>().instance;
  const detail = await app.inject({ url: `/v1/instances/${instance}`, headers });
  expect(detail.statusCode).toBe(200);
  expect(
    detail
      .json<{ envelope: { assets: { symbol: string }[] } }>()
      .envelope.assets.map((a) => a.symbol),
  ).toEqual(symbols);
});

test("an order pointing past the end of the signed asset list is refused, not clamped", async () => {
  // asset: 3 with three assets signed. Nothing downstream would notice a silent clamp to the
  // last index; it would simply buy Tesla forever on Apple's signal.
  const outOfRange = {
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
                to: "watch",
                actions: [
                  { action: "order", asset: 3, side: "buy", size: { unit: "quote", value: "10" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const r = await app.inject({
    method: "POST",
    url: "/v1/strategies/draft",
    headers,
    payload: {
      name: "Off by one",
      mode: "auto",
      plan: outOfRange,
      caps,
      assets: ["AAPLc", "NVDAc", "TSLAc"],
    },
  });
  expect(r.statusCode).toBe(400);
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

test("delegation carries a draft's automatic mode through the whole app, and withdrawing it pauses the strategy", async () => {
  // Alice's wallet is delegated: the draft asked for auto, so the instance is created auto and
  // arms without any further ceremony.
  const { instance } = await create();
  const created = await app.inject({ url: `/v1/instances/${instance}`, headers });
  expect(created.json<{ mode: string; requested_mode: string }>()).toMatchObject({
    mode: "auto",
    requested_mode: "auto",
  });
  const me = await app.inject({ url: "/v1/me", headers });
  expect(me.json<{ automation: unknown }>().automation).toEqual({
    supported: true,
    signer_id: "kq_test",
    wallet: alice.address.toLowerCase(),
    delegated: true,
  });
  const armed = await app.inject({ method: "POST", url: `/v1/instances/${instance}/arm`, headers });
  expect(armed.json<{ status: string; mode: string }>()).toMatchObject({
    status: "armed",
    mode: "auto",
  });

  // The user removes the delegation in Privy and the client tells the API to look again.
  delegated.clear();
  try {
    const off = await app.inject({
      method: "POST",
      url: "/v1/me/automation",
      headers,
      payload: { wallet: alice.address },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json<Record<string, unknown>>()).toEqual({
      wallet: alice.address.toLowerCase(),
      delegated: false,
      signer_id: "kq_test",
    });
    const after = await app.inject({ url: `/v1/instances/${instance}`, headers });
    expect(after.json<{ mode: string; status: string }>()).toMatchObject({
      mode: "manual",
      status: "paused",
    });
    const refused = await app.inject({
      method: "POST",
      url: `/v1/instances/${instance}/arm`,
      headers,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe("automation-required");
  } finally {
    delegated.add(alice.address.toLowerCase());
  }
});
