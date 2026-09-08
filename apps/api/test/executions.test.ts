import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { loadConfig } from "@mandate/config";
import { type ChainReader, type Hex, Problem } from "@mandate/contracts";
import { connectDatabase, type Database, Repository, schema, tenant } from "@mandate/database";
import { ASSETS, permissionTypedData, USDC } from "@mandate/evm";
import { drizzle } from "drizzle-orm/pglite";
import { keccak256, pad, toHex, verifyMessage, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildApp } from "../src/app.js";
import {
  BaseReceiptReader,
  fillPricing,
  type ReceiptReader,
  registerInstanceExecutions,
  type Settlement,
  type SettlementReceipt,
  settlementFrom,
  TRANSFER_TOPIC,
  tokenAmount,
} from "../src/modules/executions/index.js";

const alice = privateKeyToAccount(`0x${"11".repeat(32)}`);
const bob = privateKeyToAccount(`0x${"22".repeat(32)}`);
const spender = `0x${"33".repeat(20)}` as Hex;
function catalogue(symbol: string) {
  const asset = ASSETS.find((a) => a.symbol === symbol);
  if (!asset) throw new Error(`Missing catalogue asset: ${symbol}`);
  return asset;
}
/** Eight decimals, not eighteen. Every amount assertion below depends on that being honoured. */
const AAPL = catalogue("AAPLc");

const nativeUrl = process.env.TEST_DATABASE_URL;
const pg = nativeUrl ? undefined : new PGlite();
const native = nativeUrl ? connectDatabase(nativeUrl) : undefined;
let database: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let aliceId: string;

/** Canned settlements the route's fake reader answers with, keyed by transaction hash. */
const settlements = new Map<string, Settlement | null>();
let readerThrows = false;
let readerCalls = 0;
const receipts: ReceiptReader = {
  settlement: async ({ hash }) => {
    readerCalls++;
    if (readerThrows) throw new Error("rpc exploded");
    return settlements.get(hash.toLowerCase()) ?? null;
  },
};

const chain: ChainReader = {
  ready: async () => true,
  market: async () => [],
  quote: async () => {
    throw Problem.unavailable("No route");
  },
  walletKind: async () => "base_account",
  permissionStatus: async () => ({ approved: false, revoked: false }),
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
        { kind: "const", value: "400" },
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
                { action: "order", asset: 0, side: "buy", size: { unit: "quote", value: "632" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};
// Roomy enough that a realistic 632 USDC order is inside the caps it was signed against.
const caps = {
  lifetime: "10000",
  per_order: "1000",
  per_period: "2000",
  period_secs: 86400,
  max_orders_per_period: 10,
  cooldown_secs: 60,
  expires_at: new Date(Date.now() + 86400_000).toISOString(),
  slippage_bps: 50,
};

beforeAll(async () => {
  if (pg) {
    const dir = new URL("../../../packages/database/migrations/", import.meta.url);
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort())
      await pg.exec(await readFile(new URL(file, dir), "utf8"));
    // A role without BYPASSRLS. Under FORCE ROW LEVEL SECURITY this is what makes the tenant
    // isolation assertions below mean anything at all.
    await pg.exec(
      "create role api_test nologin; grant usage on schema mandate_v2 to api_test; grant select,insert,update,delete on all tables in schema mandate_v2 to api_test; set role api_test",
    );
  }
  const resolved = pg ? (drizzle(pg, { schema }) as unknown as Database) : native?.db;
  if (!resolved) throw new Error("Test database is missing");
  database = resolved;
  const repository = new Repository(database);
  aliceId = (await repository.resolvePrivyUser("did:privy:alice")).id;
  await repository.resolvePrivyUser("did:privy:bob");
  app = await buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test:test@localhost/test",
      PRIVY_APP_ID: "test",
      PRIVY_APP_SECRET: "test",
      LOG_LEVEL: "silent",
      DEV_COUNTRY: "GB",
      ELIGIBLE_COUNTRIES: "GB",
      SPENDER_ADDRESS: spender,
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
    // app.ts owns the registration now, so the receipt reader and the shortened refusal window
    // are injected rather than applied by registering the module a second time.
    executions: { receipts, refusalWindowSecs: 3600 },
  });
  await app.ready();
}, 30000);

afterAll(async () => {
  await app?.close();
  await pg?.close();
  await native?.close();
});

const headers = { authorization: "Bearer alice" };

async function instance() {
  const drafted = await app.inject({
    method: "POST",
    url: "/v1/strategies/draft",
    headers,
    payload: { name: "AAPL entry", mode: "auto", plan, caps, assets: ["AAPLc"] },
  });
  expect(drafted.statusCode).toBe(201);
  const body = drafted.json<{ artifact_id: string; confirm_message: string }>();
  const created = await app.inject({
    method: "POST",
    url: "/v1/strategies",
    headers,
    payload: {
      artifact_id: body.artifact_id,
      signature: await alice.signMessage({ message: body.confirm_message }),
    },
  });
  expect(created.statusCode).toBe(201);
  return created.json<{ instance: string }>().instance;
}

type OrderInput = {
  instance: string;
  at: Date;
  status: string;
  stage?: string;
  amountIn?: string;
  reason?: string | null;
  txHash?: string | null;
  side?: "buy" | "sell";
};

/** Writes an admitted order exactly as Admission.run would, through the tenant context. */
async function order(input: OrderInput) {
  const id = randomUUID();
  const side = input.side ?? "buy";
  await tenant(database, aliceId, async (tx) => {
    await tx.insert(schema.executions).values({
      id,
      userId: aliceId,
      instanceId: input.instance,
      status: input.status,
      stage: input.stage ?? "fund",
      tokenIn: side === "buy" ? USDC : AAPL.token,
      tokenOut: side === "buy" ? AAPL.token : USDC,
      amountIn: input.amountIn ?? "632000000",
      txHash: input.txHash ?? null,
      reason: input.reason ?? null,
      intent: { asset: 0, side, amount: side === "buy" ? "632" : "2", fireKey: "buy/watch/0" },
      createdAt: input.at,
      updatedAt: input.at,
    });
  });
  return id;
}

let nonce = 0;
async function leg(
  execution: string,
  input: {
    leg: "fund" | "approve" | "swap" | "reset" | "refund";
    status: "signed" | "confirmed" | "reverted";
    at: Date;
    evidence?: { token: string; recipient: string; amount: string; from?: string } | null;
  },
) {
  const hash = keccak256(toHex(`${execution}:${input.leg}`));
  await tenant(database, aliceId, async (tx) => {
    await tx.insert(schema.transactions).values({
      id: randomUUID(),
      userId: aliceId,
      executionId: execution,
      leg: input.leg,
      signer: spender.toLowerCase(),
      nonce: nonce++,
      rawTransaction: `0x02f8${"ab".repeat(40)}`,
      hash,
      status: input.status,
      evidence: input.evidence ?? null,
      createdAt: input.at,
      confirmedAt: input.status === "signed" ? null : input.at,
    });
  });
  return hash;
}

async function evaluation(input: {
  instance: string;
  at: Date;
  outcome: string;
  admitted?: number;
  refused?: string | null;
  inputs?: Record<string, string>;
  notifications?: string[];
}) {
  await tenant(database, aliceId, async (tx) => {
    await tx.insert(schema.evaluations).values({
      id: randomUUID(),
      userId: aliceId,
      instanceId: input.instance,
      at: input.at,
      outcome: input.outcome,
      admitted: input.admitted ?? 0,
      refused: input.refused ?? null,
      inputs: input.inputs ?? { "oracle:AAPLc": "320.08", "dex:AAPLc": "320.22" },
      notifications: input.notifications ?? [],
    });
  });
}

const gasFields = { gasUsed: 210_000n, effectiveGasPrice: 5_000_000n, l1Fee: 1_234_567_890_000n };

function settlement(over: Partial<Settlement> = {}): Settlement {
  return {
    status: "confirmed",
    block_number: "36000000",
    confirmations: 12,
    gas_used: "210000",
    effective_gas_price_wei: "5000000",
    gas: {
      l2_wei: "1050000000000",
      l1_wei: "1234567890000",
      fee_wei: "2284567890000",
      fee_eth: "0.00000228456789",
    },
    received: null,
    ...over,
  };
}

const transferLog = (token: string, to: string, value: bigint) => ({
  address: token,
  data: pad(toHex(value), { size: 32 }),
  topics: [TRANSFER_TOPIC, pad(alice.address, { size: 32 }), pad(to as Hex, { size: 32 })],
});

test("settlementFrom credits only standard Transfers of the expected token to the recipient", () => {
  const receipt: SettlementReceipt = {
    status: "success",
    blockNumber: 100n,
    ...gasFields,
    logs: [
      // The fill: 2 AAPLc, at the asset's eight decimals.
      transferLog(AAPL.token, alice.address, 200_000_000n),
      // A different token to the same recipient: not this fill.
      transferLog(USDC, alice.address, 999_000_000n),
      // The right token to somebody else: a router hop, not the user's delivery.
      transferLog(AAPL.token, spender, 500_000_000n),
      // A non-Transfer event from the token.
      {
        address: AAPL.token,
        data: pad(toHex(7n), { size: 32 }),
        topics: [keccak256(toHex("Approval(address,address,uint256)"))],
      },
    ],
  };
  const result = settlementFrom(receipt, 112n, {
    token: AAPL.token,
    recipient: alice.address,
  });
  expect(result.received).toBe("200000000");
  expect(result.status).toBe("confirmed");
  expect(result.confirmations).toBe(13);
  // L1 data fee is part of what the transaction cost; leaving it out understates the fee.
  expect(result.gas.l2_wei).toBe("1050000000000");
  expect(result.gas.fee_wei).toBe("2284567890000");
  expect(result.gas.fee_eth).toBe("0.00000228456789");
});

test("settlementFrom reports no transfer for a reverted receipt and none at all when unasked", () => {
  const reverted: SettlementReceipt = {
    status: "reverted",
    blockNumber: 100n,
    ...gasFields,
    logs: [transferLog(AAPL.token, alice.address, 200_000_000n)],
  };
  expect(
    settlementFrom(reverted, 100n, { token: AAPL.token, recipient: alice.address }),
  ).toMatchObject({ status: "reverted", received: "0", confirmations: 1 });
  // An approve leg moves nothing; "0 received" would be a claim, null is the absence of one.
  const approve = settlementFrom(
    { status: "success", blockNumber: 100n, ...gasFields, logs: [] },
    100n,
  );
  expect(approve.received).toBeNull();
  expect(approve.gas.fee_wei).toBe("2284567890000");
});

test("BaseReceiptReader caches, de-duplicates and degrades to null instead of throwing", async () => {
  let calls = 0;
  let fail = false;
  const reader = new BaseReceiptReader(
    {
      getTransactionReceipt: async () => {
        calls++;
        if (fail) throw new Error("rate limited");
        return {
          status: "success" as const,
          blockNumber: 10n,
          ...gasFields,
          logs: [transferLog(AAPL.token, alice.address, 200_000_000n)],
        };
      },
      getBlockNumber: async () => 12n,
    },
    { ttlMs: 60_000, deadlineMs: 500 },
  );
  const hash = keccak256(toHex("cache"));
  const expect1 = { token: AAPL.token, recipient: alice.address };
  // Two concurrent asks for the same hash share one RPC round trip.
  const [a, b] = await Promise.all([
    reader.settlement({ hash, expect: expect1 }),
    reader.settlement({ hash, expect: expect1 }),
  ]);
  expect(a?.received).toBe("200000000");
  expect(b?.received).toBe("200000000");
  expect(calls).toBe(1);
  await reader.settlement({ hash, expect: expect1 });
  expect(calls).toBe(1);
  // A different expectation over the same transaction is a different question and is not
  // answered from the first one's cache entry.
  const other = await reader.settlement({ hash, expect: { token: USDC, recipient: spender } });
  expect(other?.received).toBe("0");
  expect(calls).toBe(2);
  fail = true;
  const failed = await reader.settlement({ hash: keccak256(toHex("broken")), expect: expect1 });
  expect(failed).toBeNull();
});

test("BaseReceiptReader gives up on a hanging node rather than holding the request", async () => {
  const reader = new BaseReceiptReader(
    {
      getTransactionReceipt: () => new Promise(() => {}),
      getBlockNumber: async () => 1n,
    },
    { deadlineMs: 30 },
  );
  expect(await reader.settlement({ hash: keccak256(toHex("slow")) })).toBeNull();
});

test("list is scoped to the caller, filterable, and keyset-paged through equal timestamps", async () => {
  const first = await instance();
  const second = await instance();
  const at = new Date("2026-03-02T15:04:05.123Z");
  const a = await order({ instance: first, at, status: "confirmed" });
  const b = await order({ instance: first, at, status: "cancelled" });
  const c = await order({
    instance: second,
    at: new Date(at.getTime() - 1000),
    status: "signal",
  });

  const all = await app.inject({ url: "/v1/executions?limit=50", headers });
  expect(all.statusCode).toBe(200);
  const ids = all.json<{ items: { id: string }[] }>().items.map((i) => i.id);
  expect(ids).toEqual(expect.arrayContaining([a, b, c]));

  const scoped = await app.inject({ url: `/v1/executions?instance=${second}`, headers });
  expect(scoped.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([c]);

  const filtered = await app.inject({
    url: `/v1/executions?instance=${first}&status=cancelled,reverted`,
    headers,
  });
  expect(filtered.json<{ items: { id: string }[] }>().items.map((i) => i.id)).toEqual([b]);
  expect(
    (await app.inject({ url: "/v1/executions?status=not-a-status", headers })).statusCode,
  ).toBe(400);

  // Two orders admitted by one tick share a millisecond. A created_at-only cursor would drop
  // the second at the page boundary; the (created_at, id) keyset keeps both.
  type Page = { items: { id: string }[]; next_page: { before: string; before_id: string } | null };
  const page1 = (
    await app.inject({ url: `/v1/executions?instance=${first}&limit=1`, headers })
  ).json<Page>();
  expect(page1.next_page).not.toBeNull();
  const cursor = new URLSearchParams({
    instance: first,
    limit: "1",
    ...(page1.next_page as { before: string; before_id: string }),
  });
  const page2 = (await app.inject({ url: `/v1/executions?${cursor}`, headers })).json<Page>();
  expect(new Set([page1.items[0]?.id, page2.items[0]?.id])).toEqual(new Set([a, b]));

  const foreign = { authorization: "Bearer bob" };
  expect(
    (await app.inject({ url: "/v1/executions", headers: foreign })).json<{ items: unknown[] }>()
      .items,
  ).toHaveLength(0);
  expect((await app.inject({ url: `/v1/executions/${a}`, headers: foreign })).statusCode).toBe(404);
  // A foreign instance filter is 404, not an empty page that reads as "nothing ever happened".
  expect(
    (await app.inject({ url: `/v1/executions?instance=${first}`, headers: foreign })).statusCode,
  ).toBe(404);
  expect(
    (await app.inject({ url: `/v1/instances/${first}/executions/summary`, headers: foreign }))
      .statusCode,
  ).toBe(404);
});

test("a fill reports the eight-decimal amount, the realised price and the gas someone else paid", async () => {
  const target = await instance();
  const at = new Date("2026-03-03T15:04:05.000Z");
  await evaluation({
    instance: target,
    at,
    outcome: "evaluated",
    admitted: 1,
    refused: "Cooldown active",
    notifications: ["Entering position"],
  });
  const id = await order({ instance: target, at, status: "confirmed", stage: "done" });
  const fund = await leg(id, {
    leg: "fund",
    status: "confirmed",
    at,
    evidence: {
      token: USDC,
      recipient: spender,
      amount: "632000000",
      from: alice.address,
    },
  });
  const approve = await leg(id, { leg: "approve", status: "confirmed", at });
  // The durable evidence for a swap is amountOutMinimum — the floor, not the fill.
  const swap = await leg(id, {
    leg: "swap",
    status: "confirmed",
    at,
    evidence: { token: AAPL.token, recipient: alice.address, amount: "197500000" },
  });
  settlements.set(fund, settlement({ received: "632000000" }));
  settlements.set(approve, settlement());
  settlements.set(swap, settlement({ received: "200000000" }));

  const response = await app.inject({ url: `/v1/executions/${id}`, headers });
  expect(response.statusCode).toBe(200);
  const body = response.json<{
    outcome: string;
    symbol: string;
    spent: { amount: string; decimals: number };
    fill: {
      state: string;
      guaranteed_minimum: { amount: string; decimals: number };
      received: { amount: string };
      price: {
        basis: string;
        guaranteed_price: string;
        filled_price: string;
        difference_bps: string;
        direction: string;
      };
    };
    cost: {
      input: { amount: string };
      gas: { fee_eth: string; legs: number; complete: boolean; paid_by: string; borne_by: string };
    };
    decision: { refusals: { code: string }[]; inputs: Record<string, string>; admitted: number };
    journal: { leg: string; expectation: { kind: string; amount: { amount: string } } | null }[];
    explorer_url: string;
  }>();

  expect(body.outcome).toBe("filled");
  expect(body.symbol).toBe("AAPLc");
  // 632 USDC in at six decimals; 2 AAPLc out at eight. A hardcoded 18 would render both wrong.
  expect(body.spent).toMatchObject({ amount: "632", decimals: 6 });
  expect(body.fill.state).toBe("verified");
  expect(body.fill.guaranteed_minimum).toMatchObject({ amount: "1.975", decimals: 8 });
  expect(body.fill.received.amount).toBe("2");
  expect(body.fill.price.basis).toBe("guaranteed_minimum");
  expect(body.fill.price.guaranteed_price).toBe("320");
  expect(body.fill.price.filled_price).toBe("316");
  // Filled 4 USDC per share better than the floor of 320: 125 bps, and on a buy that is good.
  expect(body.fill.price.difference_bps).toBe("-125.00");
  expect(body.fill.price.direction).toBe("favourable");
  // Three settled legs at 0.00000228456789 ETH each, borne by the executor's wallet.
  expect(body.cost.gas.legs).toBe(3);
  expect(body.cost.gas.complete).toBe(true);
  expect(body.cost.gas.fee_eth).toBe("0.00000685370367");
  expect(body.cost.gas.paid_by).toBe(spender.toLowerCase());
  expect(body.cost.gas.borne_by).toBe("executor");
  expect(body.cost.input.amount).toBe("632");
  expect(body.decision.admitted).toBe(1);
  expect(body.decision.inputs["oracle:AAPLc"]).toBe("320.08");
  expect(body.decision.refusals.map((r) => r.code)).toEqual(["cooldown"]);
  const swapEntry = body.journal.find((entry) => entry.leg === "swap");
  expect(swapEntry?.expectation).toMatchObject({
    kind: "guaranteed_minimum",
    amount: { amount: "1.975" },
  });

  // Nothing secret crosses the boundary, whatever the response grows into later.
  const raw = response.body;
  expect(raw).not.toContain("rawTransaction");
  expect(raw).not.toContain("raw_transaction");
  expect(raw).not.toContain(aliceId);
  expect(raw).not.toContain("0x02f8");
});

test("a fill with no receipt says so instead of presenting the slippage floor as the fill", async () => {
  const target = await instance();
  const at = new Date("2026-03-04T09:00:00.000Z");
  const id = await order({ instance: target, at, status: "confirmed", stage: "done" });
  await leg(id, {
    leg: "swap",
    status: "confirmed",
    at,
    evidence: { token: AAPL.token, recipient: alice.address, amount: "197500000" },
  });
  // No canned settlement for this hash: the reader answers null, as a pruned or rate-limited
  // node would.
  const body = (await app.inject({ url: `/v1/executions/${id}`, headers })).json<{
    fill: {
      state: string;
      reason: string;
      received: unknown;
      guaranteed_minimum: { amount: string };
      price: { filled_price: string | null; difference_bps: string | null; direction: null };
    };
    cost: unknown;
  }>();
  expect(body.fill.state).toBe("unverified");
  expect(body.fill.received).toBeNull();
  expect(body.fill.guaranteed_minimum.amount).toBe("1.975");
  expect(body.fill.price.filled_price).toBeNull();
  expect(body.fill.price.difference_bps).toBeNull();
  expect(body.fill.reason).toContain("what was signed, not what was filled");
  // No settlement anywhere means no gas figure either, rather than a zero that reads as free.
  expect(body.cost).toBeNull();
});

test("a broken chain reader degrades the detail route, it does not fail it", async () => {
  const target = await instance();
  const at = new Date("2026-03-04T10:00:00.000Z");
  const id = await order({ instance: target, at, status: "confirmed", stage: "done" });
  await leg(id, {
    leg: "swap",
    status: "confirmed",
    at,
    evidence: { token: AAPL.token, recipient: alice.address, amount: "197500000" },
  });
  readerThrows = true;
  try {
    const response = await app.inject({ url: `/v1/executions/${id}`, headers });
    // The durable record is still the answer. A 503 here would hide it behind the RPC.
    expect(response.statusCode).toBe(200);
    expect(response.json<{ fill: { state: string } }>().fill.state).toBe("unverified");
    expect(response.json<{ journal: { settlement: null }[] }>().journal[0]?.settlement).toBeNull();
  } finally {
    readerThrows = false;
  }
});

test("a signal and a pre-funding cancellation are reported as decisions, not as failures", async () => {
  const target = await instance();
  const at = new Date("2026-03-05T09:00:00.000Z");
  const signal = await order({ instance: target, at, status: "signal" });
  const cancelled = await order({
    instance: target,
    at: new Date(at.getTime() + 1),
    status: "cancelled",
    stage: "fund",
    reason: "Admission checks failed before funding",
  });

  const one = (await app.inject({ url: `/v1/executions/${signal}`, headers })).json<{
    outcome: string;
    headline: string;
    fill: { state: string; reason: string };
    reason: unknown;
    journal: unknown[];
  }>();
  expect(one.outcome).toBe("signal");
  expect(one.headline).toBe("Signalled, not traded");
  expect(one.fill.state).toBe("not_applicable");
  expect(one.fill.reason).toContain("manual mode");
  expect(one.journal).toEqual([]);
  expect(one.reason).toBeNull();

  const two = (await app.inject({ url: `/v1/executions/${cancelled}`, headers })).json<{
    outcome: string;
    reason: { code: string; message: string; raw: string };
  }>();
  expect(two.outcome).toBe("cancelled");
  expect(two.reason.code).toBe("preconditions-failed");
  expect(two.reason.message).toContain("Nothing was spent");
  // The raw worker string is always kept so an operator and a user read the same event.
  expect(two.reason.raw).toBe("Admission checks failed before funding");
});

test("an unrecognised worker reason is shown verbatim rather than swallowed", async () => {
  const target = await instance();
  const at = new Date("2026-03-05T11:00:00.000Z");
  const id = await order({
    instance: target,
    at,
    status: "recovery_required",
    reason: "Some future failure mode",
  });
  const body = (await app.inject({ url: `/v1/executions/${id}`, headers })).json<{
    outcome: string;
    reason: { code: string; message: string };
  }>();
  expect(body.outcome).toBe("needs_review");
  expect(body.reason).toMatchObject({ code: "other", message: "Some future failure mode" });
});

test("the summary separates what the caps counted from what actually settled, and lists refusals", async () => {
  const target = await instance();
  const base = new Date("2026-03-06T09:00:00.000Z");
  await order({ instance: target, at: base, status: "confirmed", amountIn: "632000000" });
  await order({
    instance: target,
    at: new Date(base.getTime() + 1000),
    status: "refunded",
    amountIn: "100000000",
    reason: "Input returned to strategy account",
  });
  await order({
    instance: target,
    at: new Date(base.getTime() + 2000),
    status: "cancelled",
    amountIn: "50000000",
  });
  const recent = Date.now();
  await evaluation({
    instance: target,
    at: new Date(recent - 60_000),
    outcome: "evaluated",
    refused: "Cooldown active; Per-order cap exceeded",
  });
  await evaluation({
    instance: target,
    at: new Date(recent - 50_000),
    outcome: "evaluated",
    refused: "Cooldown active",
  });
  await evaluation({ instance: target, at: new Date(recent - 40_000), outcome: "evaluated" });
  await evaluation({
    instance: target,
    at: new Date(recent - 30_000),
    outcome: "observation-or-authority-unavailable",
    refused: "observation-or-authority-unavailable",
  });
  // Outside the declared one-hour window: it must not be counted.
  await evaluation({
    instance: target,
    at: new Date(recent - 7 * 86_400_000),
    outcome: "evaluated",
    refused: "Lifetime cap exceeded",
  });

  const body = (
    await app.inject({ url: `/v1/instances/${target}/executions/summary`, headers })
  ).json<{
    orders: { total: number; by_outcome: Record<string, number>; first_at: string };
    spend: {
      admitted: string;
      settled: string;
      returned: string;
      not_executed: string;
      remaining: string;
      lifetime_cap: string;
      cap_notice: string;
    };
    refusals: {
      ticks: number;
      window: { secs: number };
      outcomes: { code: string; ticks: number }[];
      reasons: { code: string; ticks: number }[];
      truncated: boolean;
    };
  }>();

  expect(body.orders.total).toBe(3);
  expect(body.orders.by_outcome).toMatchObject({ filled: 1, refunded: 1, cancelled: 1 });
  expect(body.orders.first_at).toBe(base.toISOString());
  expect(body.spend.settled).toBe("632");
  expect(body.spend.returned).toBe("100");
  expect(body.spend.not_executed).toBe("50");
  // runtime.lifetime is what the caps counted; these rows were written straight to the table,
  // so the honest answer is that the caps have counted nothing.
  expect(body.spend.admitted).toBe("0");
  expect(body.spend.remaining).toBe("10000");
  expect(body.spend.lifetime_cap).toBe("10000");
  expect(body.spend.cap_notice).toContain("do not give back cap headroom");

  expect(body.refusals.window.secs).toBe(3600);
  expect(body.refusals.ticks).toBe(4);
  expect(body.refusals.truncated).toBe(false);
  const reasons = new Map(body.refusals.reasons.map((r) => [r.code, r.ticks]));
  expect(reasons.get("cooldown")).toBe(2);
  expect(reasons.get("per-order-cap")).toBe(1);
  // The row seven days back is outside the declared window and is not counted.
  expect(reasons.has("lifetime-cap")).toBe(false);
  const outcomes = new Map(body.refusals.outcomes.map((r) => [r.code, r.ticks]));
  expect(outcomes.get("evaluated")).toBe(3);
  expect(outcomes.get("observation-unavailable")).toBe(1);
});

test("the module coexists with registerTrading without colliding on a route", async () => {
  const target = await instance();
  const at = new Date("2026-03-07T09:00:00.000Z");
  await order({ instance: target, at, status: "confirmed" });
  // The legacy per-instance route is still owned by modules/strategies and still answers.
  const legacy = await app.inject({ url: `/v1/instances/${target}/executions`, headers });
  expect(legacy.statusCode).toBe(200);
  expect(legacy.json<{ items: unknown[] }>().items).toHaveLength(1);
  // The summary is a distinct static child segment of the same prefix.
  expect(
    (await app.inject({ url: `/v1/instances/${target}/executions/summary`, headers })).statusCode,
  ).toBe(200);
  // And unauthenticated callers get nothing from any of it.
  expect((await app.inject({ url: "/v1/executions" })).statusCode).toBe(401);
  expect(readerCalls).toBeGreaterThan(0);
});

const envelope = {
  version: "mandate/2" as const,
  caps,
  assets: [AAPL],
  quote: USDC,
  venue: "aerodrome" as const,
};

test("the price difference flips direction between a buy and a sell", () => {
  // Same 126.58 bps gap in both cases. What it means to the user is the opposite each way.
  const bought = fillPricing(
    "buy",
    tokenAmount(envelope, USDC, "632000000"),
    tokenAmount(envelope, AAPL.token, "200000000"),
    tokenAmount(envelope, AAPL.token, "197500000"),
  );
  expect(bought.guaranteed_price).toBe("316");
  expect(bought.filled_price).toBe("320");
  expect(bought.difference_bps).toBe("126.58");
  // Paying more per share than the floor allowed for is adverse on a buy.
  expect(bought.direction).toBe("adverse");
  expect(bought.base_symbol).toBe("AAPLc");
  expect(bought.quote_symbol).toBe("USDC");

  const sold = fillPricing(
    "sell",
    tokenAmount(envelope, AAPL.token, "200000000"),
    tokenAmount(envelope, USDC, "632000000"),
    tokenAmount(envelope, USDC, "640000000"),
  );
  expect(sold.guaranteed_price).toBe("316");
  expect(sold.filled_price).toBe("320");
  expect(sold.difference_bps).toBe("126.58");
  // Receiving more per share than the floor guaranteed is favourable on a sell.
  expect(sold.direction).toBe("favourable");
  expect(sold.base_symbol).toBe("AAPLc");

  // An exact fill at the floor is neither, and must not render as "-0.00".
  const level = fillPricing(
    "buy",
    tokenAmount(envelope, USDC, "632000000"),
    tokenAmount(envelope, AAPL.token, "200000000"),
    tokenAmount(envelope, AAPL.token, "200000000"),
  );
  expect(level.difference_bps).toBe("0.00");
  expect(level.direction).toBe("at_limit");

  // A token outside the signed envelope reports the raw integer rather than guessing a scale.
  const unknown = tokenAmount(envelope, `0x${"cd".repeat(20)}`, "12345");
  expect(unknown).toMatchObject({ decimals: null, amount: null, raw: "12345" });
});

test("registerInstanceExecutions serves the enriched shape apps/web already reads", async () => {
  const target = await instance();
  const at = new Date("2026-03-08T09:00:00.000Z");
  const id = await order({
    instance: target,
    at,
    status: "confirmed",
    txHash: `0x${"ee".repeat(32)}`,
  });
  // A second app without the trading module, because modules/strategies still owns this path
  // and two declarations of it are a boot failure rather than a runtime 404.
  const replacement = await buildApp({
    config: loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test:test@localhost/test",
      PRIVY_APP_ID: "test",
      PRIVY_APP_SECRET: "test",
      LOG_LEVEL: "silent",
      DEV_COUNTRY: "GB",
      ELIGIBLE_COUNTRIES: "GB",
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
    users: new Repository(database),
    databaseReady: async () => true,
    chainReady: chain.ready,
  });
  try {
    await registerInstanceExecutions(replacement, { repository: new Repository(database) });
    await replacement.ready();
    const response = await replacement.inject({
      url: `/v1/instances/${target}/executions`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const [item] = response.json<{ items: Record<string, unknown>[] }>().items;
    if (!item) throw new Error("Expected one execution");
    expect(item).toMatchObject({
      id,
      outcome: "filled",
      symbol: "AAPLc",
      explorer_url: `https://basescan.org/tx/0x${"ee".repeat(32)}`,
    });
    // The compatibility keys apps/web reads today must stay equal to the honest fields, or the
    // two halves of this response would drift into disagreeing about the same order.
    expect(item.instanceId).toBe(item.instance as string);
    expect(item.amountIn).toBe((item.spent as { raw: string }).raw);
    expect(item.txHash).toBe(item.tx_hash as string);
    expect(item.createdAt).toBe(item.created_at as string);
    // Ownership is still asserted, not left to an empty page.
    expect(
      (
        await replacement.inject({
          url: `/v1/instances/${target}/executions`,
          headers: { authorization: "Bearer bob" },
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await replacement.close();
  }
});
