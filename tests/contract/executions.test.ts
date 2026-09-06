import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settlement } from "../../apps/api/src/modules/executions/index.js";
import { EXECUTION_STATUSES } from "../../packages/contracts/src/index.js";
import {
  type Committed,
  type ContractApi,
  call,
  commitStrategy,
  newIdentity,
  StubReceipts,
  seedEvaluation,
  seedExecution,
  seedTransaction,
  startContractApi,
  type TestIdentity,
} from "./harness.js";
import {
  executionDetailSchema,
  executionListItemSchema,
  fractionDigits,
  pageOf,
  parsed,
  problemSchema,
  summarySchema,
} from "./schemas.js";

/**
 * `/v1/executions`, `/v1/executions/:id`, `/v1/instances/:id/executions` and its summary — the
 * user's record of what actually happened.
 *
 * The invariant that runs through all of it: this response may never claim more than the chain
 * proves. The durable record of a swap is `amountOutMinimum`, the slippage floor the worker
 * signed, and presenting that floor as the fill would claim zero slippage on every trade ever
 * made. So `fill.state` is "verified" only when a receipt was actually decoded, and the sentence
 * beside it says which of the four reasons it is not.
 *
 * The list item also carries a camelCase compatibility block that apps/web still reads off the
 * raw row. Those keys are duplicated values, not spare ones: deleting them is a breaking change
 * until apps/web moves to the snake_case fields.
 */

const RECEIPT: Settlement = {
  status: "confirmed",
  block_number: "24000000",
  confirmations: 3,
  gas_used: "121000",
  effective_gas_price_wei: "1500000",
  gas: {
    l2_wei: "181500000000",
    // Base charges an OP-stack L1 data fee on top of L2 execution. Omitting it understates the
    // real cost of the transaction, and it has historically been the larger half.
    l1_wei: "42000000000",
    fee_wei: "223500000000",
    fee_eth: "0.0000002235",
  },
  // 0.03122852 AAPLc at 8 decimals: the amount actually credited, summed from Transfer logs.
  received: "3122852",
};

let api: ContractApi;
let alice: TestIdentity;
let user: string;
let strategy: Committed;

beforeAll(async () => {
  alice = newIdentity();
  api = await startContractApi({ identities: [alice] });
  user = (await call(api, { url: "/v1/me", token: alice.token })).json<{ user: string }>().user;
  strategy = await commitStrategy(api, alice);
}, 60_000);

afterAll(async () => {
  await api.close();
}, 30_000);

describe("GET /v1/executions", () => {
  test("the page validates and every amount is an integer string in its own smallest unit", async () => {
    await seedExecution(api, user, strategy.instance, {
      status: "confirmed",
      txHash: `0x${"11".repeat(32)}`,
    });
    const response = await call(api, { url: "/v1/executions", token: alice.token });
    expect(response.statusCode).toBe(200);
    const page = parsed(pageOf(executionListItemSchema), response.json());
    const item = page.items[0];
    expect(item).toBeDefined();
    // 10 USDC at 6 decimals. `spent.raw` is what the chain moved and `spent.amount` is the
    // rendering of it; a consumer that must be exact reads `raw` and only display reads
    // `amount`.
    expect(item?.spent.raw).toBe("10000000");
    expect(item?.spent.decimals).toBe(6);
    expect(item?.spent.amount).toBe("10");
    expect(item?.amountIn).toBe("10000000");
    // The traded asset is the non-USDC side of the pair, resolved from the signed envelope
    // rather than from a global catalogue: `intent.asset` indexes `envelope.assets`.
    expect(item?.symbol).toBe("AAPLc");
    expect(item?.side).toBe("buy");
  });

  test("the camelCase compatibility block mirrors the snake_case fields exactly", async () => {
    const page = parsed(
      pageOf(executionListItemSchema),
      (await call(api, { url: "/v1/executions", token: alice.token })).json(),
    );
    for (const item of page.items) {
      expect(item.instanceId).toBe(item.instance);
      expect(item.amountIn).toBe(item.spent.raw);
      expect(item.txHash).toBe(item.tx_hash);
      expect(item.createdAt).toBe(item.created_at);
      // Same value under two names is the whole point. The moment they can differ, one of them
      // is wrong and nothing in the response says which.
    }
  });

  test("each status maps to a settled outcome with a headline and a sentence", async () => {
    const other = newIdentity();
    const api2 = await startContractApi({ identities: [other] });
    try {
      const own = await commitStrategy(api2, other);
      const owner = (await call(api2, { url: "/v1/me", token: other.token })).json<{
        user: string;
      }>().user;
      // One order per status the CHECK allows, so the vocabulary cannot gain a member the
      // response does not describe. `recovery_required` was added by migration 0004 and a
      // hand-written copy of the list that had not learned it would silently drop the row.
      for (const [index, status] of EXECUTION_STATUSES.entries())
        await seedExecution(api2, owner, own.instance, {
          status,
          stage: status === "signal" ? "done" : "swap",
          createdAt: new Date(Date.now() - index * 1000),
        });
      const page = parsed(
        pageOf(executionListItemSchema),
        (await call(api2, { url: "/v1/executions?limit=100", token: other.token })).json(),
      );
      expect(page.items).toHaveLength(EXECUTION_STATUSES.length);
      for (const item of page.items) {
        // "Unrecognised state" is the fallback for a status this build does not know. Reaching
        // it here would mean the response vocabulary and the database CHECK have drifted.
        expect(item.headline).not.toBe("Unrecognised state");
        expect(item.what_happened.length).toBeGreaterThan(10);
      }
      // A signal is manual mode working, not a failure, and it says so in its own words.
      const signal = page.items.find((item) => item.status === "signal");
      expect(signal?.outcome).toBe("signal");
      expect(signal?.what_happened).toContain("manual mode");
      // Cancelled specifically means no funds ever left the account.
      const cancelled = page.items.find((item) => item.status === "cancelled");
      expect(cancelled?.outcome).toBe("cancelled");
      expect(cancelled?.what_happened).toContain("before any money left your account");
      // recovery_required is an operator state, not a failed trade.
      const recovery = page.items.find((item) => item.status === "recovery_required");
      expect(recovery?.outcome).toBe("needs_review");
    } finally {
      await api2.close();
    }
  }, 60_000);

  test("the status filter accepts the shared vocabulary and refuses anything else", async () => {
    const ok = await call(api, {
      url: "/v1/executions?status=confirmed,reverted",
      token: alice.token,
    });
    expect(ok.statusCode).toBe(200);
    parsed(pageOf(executionListItemSchema), ok.json());
    const bad = await call(api, { url: "/v1/executions?status=not-a-status", token: alice.token });
    // A status this build does not know is a client error, not an empty page: an empty page
    // reads as "nothing happened", which is a different and wrong answer.
    expect(bad.statusCode).toBe(400);
    expect(parsed(problemSchema, bad.json()).code).toBe("invalid-request");
  });

  test("filtering by somebody else's instance is 404, not an empty page", async () => {
    const mallory = newIdentity();
    const api2 = await startContractApi({ identities: [alice, mallory] });
    try {
      const mine = await commitStrategy(api2, alice);
      const response = await call(api2, {
        url: `/v1/executions?instance=${mine.instance}`,
        token: mallory.token,
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await api2.close();
    }
  }, 60_000);
});

describe("GET /v1/executions/:id", () => {
  test("without a receipt reader the fill is unverified and says why, and nothing is invented", async () => {
    const order = await seedExecution(api, user, strategy.instance, { status: "confirmed" });
    await seedTransaction(api, user, order.id, {
      leg: "swap",
      status: "confirmed",
      evidence: {
        amount: "3122852",
        recipient: alice.wallet,
        token: "0xb200000000000000000000C2e324d24d7eEcd1fb",
      },
    });
    const response = await call(api, { url: `/v1/executions/${order.id}`, token: alice.token });
    expect(response.statusCode).toBe(200);
    const body = parsed(executionDetailSchema, response.json());
    // The honest answer with no chain reader wired: the record shown is what was signed, not
    // what was filled. Inventing a filled amount to make the page look complete would be
    // indistinguishable from a real fill.
    expect(body.fill.state).toBe("unverified");
    expect(body.fill.reason).toContain("No chain reader is configured");
    expect(body.fill.received).toBeNull();
    expect(body.fill.price.filled_price).toBeNull();
    expect(body.fill.price.difference_bps).toBeNull();
    // The floor is still shown, under a name that says it is a floor.
    expect(body.fill.price.basis).toBe("guaranteed_minimum");
    expect(body.fill.guaranteed_minimum?.raw).toBe("3122852");
    expect(body.fill.guaranteed_minimum?.decimals).toBe(8);
    expect(body.fill.guaranteed_minimum?.amount).toBe("0.03122852");
    // No settled receipt means no fee is known, so `cost` is null rather than a zero.
    expect(body.cost).toBeNull();
    expect(body.journal[0]?.settlement).toBeNull();
  });

  test("with a receipt reader the fill is verified, priced, and the gas is attributed", async () => {
    const order = await seedExecution(api, user, strategy.instance, { status: "confirmed" });
    const swap = await seedTransaction(api, user, order.id, {
      leg: "swap",
      status: "confirmed",
      evidence: {
        amount: "3122852",
        recipient: alice.wallet,
        token: "0xb200000000000000000000C2e324d24d7eEcd1fb",
      },
    });
    const withReceipts = await startContractApi({
      identities: [alice],
      receipts: new StubReceipts(new Map([[swap.hash.toLowerCase(), RECEIPT]])),
    });
    try {
      // The order lives in the first app's database, so re-seed it into the second.
      const owner = (await call(withReceipts, { url: "/v1/me", token: alice.token })).json<{
        user: string;
      }>().user;
      const committed = await commitStrategy(withReceipts, alice);
      const seeded = await seedExecution(withReceipts, owner, committed.instance, {
        status: "confirmed",
      });
      await seedTransaction(withReceipts, owner, seeded.id, {
        leg: "swap",
        status: "confirmed",
        hash: swap.hash,
        evidence: {
          amount: "3122852",
          recipient: alice.wallet,
          token: "0xb200000000000000000000C2e324d24d7eEcd1fb",
        },
      });
      const body = parsed(
        executionDetailSchema,
        (
          await call(withReceipts, { url: `/v1/executions/${seeded.id}`, token: alice.token })
        ).json(),
      );
      expect(body.fill.state).toBe("verified");
      expect(body.fill.reason).toContain("Transfer logs");
      expect(body.fill.received?.raw).toBe("3122852");
      // Both prices are rendered at USDC precision, not at the 78-digit intermediate width.
      expect(fractionDigits(body.fill.price.guaranteed_price as string)).toBeLessThanOrEqual(6);
      expect(fractionDigits(body.fill.price.filled_price as string)).toBeLessThanOrEqual(6);
      // Received exactly the floor, so the difference is zero — and it prints "0.00", never
      // "-0.00", which reads to a user as a loss that did not happen.
      expect(body.fill.price.difference_bps).toBe("0.00");
      expect(body.fill.price.direction).toBe("at_limit");
      expect(body.cost).not.toBeNull();
      expect(body.cost?.gas.fee_wei).toBe("223500000000");
      // Gas is paid in ETH by the executor and is never taken from the user's spend permission,
      // which moves exactly the input amount. The response says so rather than netting it off.
      expect(body.cost?.gas.borne_by).toBe("executor");
      expect(body.cost?.gas.note).toContain("not deducted from your funds");
      expect(body.cost?.input.raw).toBe("10000000");
      expect(body.journal[0]?.settlement?.received).toBe("3122852");
    } finally {
      await withReceipts.close();
    }
  }, 60_000);

  test("a journal row exposes only its allowlisted fields, never the signed bytes", async () => {
    const order = await seedExecution(api, user, strategy.instance, { status: "pending" });
    await seedTransaction(api, user, order.id, { leg: "fund", status: "signed", evidence: null });
    const body = parsed(
      executionDetailSchema,
      (await call(api, { url: `/v1/executions/${order.id}`, token: alice.token })).json(),
    );
    const entry = body.journal[0];
    expect(entry?.leg).toBe("fund");
    expect(entry?.status).toBe("signed");
    // A signed, possibly un-broadcast transaction is in pino's redact list for a reason, and
    // `journalEntrySchema` is strict, so its presence here would fail the parse above. Asserted
    // again by name because this is the field that must never appear.
    const raw = JSON.stringify(entry);
    expect(raw).not.toContain("rawTransaction");
    expect(raw).not.toContain("raw_transaction");
    expect(raw).not.toContain("userId");
    // A signed leg has not settled, so there is no confirmation time and no receipt to read.
    expect(entry?.confirmed_at).toBeNull();
    expect(entry?.settlement).toBeNull();
  });

  test("the decision that admitted the order is paired by exact timestamp, or is null", async () => {
    const at = new Date();
    const order = await seedExecution(api, user, strategy.instance, {
      status: "confirmed",
      createdAt: at,
    });
    await seedEvaluation(api, user, strategy.instance, {
      at,
      outcome: "evaluated",
      admitted: 1,
      refused: "Cooldown active",
      inputs: { "oracle:AAPLc": "320.08" },
    });
    const body = parsed(
      executionDetailSchema,
      (await call(api, { url: `/v1/executions/${order.id}`, token: alice.token })).json(),
    );
    // Admission writes the evaluation and every order it admits with one `now` inside one
    // transaction, so equality is the pairing. A window would attribute a merely nearby tick's
    // prices to this fill and put numbers on the page no rule ever saw.
    expect(body.decision).not.toBeNull();
    expect(body.decision?.admitted).toBe(1);
    expect(body.decision?.inputs).toEqual({ "oracle:AAPLc": "320.08" });
    expect(body.decision?.outcome?.code).toBe("evaluated");
    // Refusals are split back apart from the "; "-joined column, and each carries the worker's
    // own string alongside the translation so an unlearned reason still shows something true.
    expect(body.decision?.refusals[0]?.code).toBe("cooldown");
    expect(body.decision?.refusals[0]?.raw).toBe("Cooldown active");

    // An order with no matching tick reports null rather than borrowing another one's numbers.
    const orphan = await seedExecution(api, user, strategy.instance, { status: "confirmed" });
    const orphanBody = parsed(
      executionDetailSchema,
      (await call(api, { url: `/v1/executions/${orphan.id}`, token: alice.token })).json(),
    );
    expect(orphanBody.decision).toBeNull();
  });

  test("a worker reason is translated but the raw string always travels with it", async () => {
    const order = await seedExecution(api, user, strategy.instance, {
      status: "reverted",
      reason: "Funding reverted",
    });
    const body = parsed(
      executionDetailSchema,
      (await call(api, { url: `/v1/executions/${order.id}`, token: alice.token })).json(),
    );
    expect(body.reason?.code).toBe("funding-reverted");
    expect(body.reason?.raw).toBe("Funding reverted");
    expect(body.reason?.message).toContain("Nothing was spent");

    // A reason this table has not learned yet is shown verbatim rather than replaced by
    // "something went wrong": it comes from our worker, never from an upstream error object.
    const novel = await seedExecution(api, user, strategy.instance, {
      status: "reverted",
      reason: "Some future reason",
    });
    const novelBody = parsed(
      executionDetailSchema,
      (await call(api, { url: `/v1/executions/${novel.id}`, token: alice.token })).json(),
    );
    expect(novelBody.reason?.code).toBe("other");
    expect(novelBody.reason?.message).toBe("Some future reason");
    expect(novelBody.reason?.raw).toBe("Some future reason");
  });

  test("an execution id that is not the caller's is 404", async () => {
    const order = await seedExecution(api, user, strategy.instance, {});
    const stranger = newIdentity();
    const api2 = await startContractApi({ identities: [stranger] });
    try {
      const response = await call(api2, {
        url: `/v1/executions/${order.id}`,
        token: stranger.token,
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await api2.close();
    }
  }, 60_000);
});

describe("GET /v1/instances/:id/executions/summary", () => {
  test("the rollup validates and separates admitted spend from settled spend", async () => {
    const owner = newIdentity();
    const api2 = await startContractApi({ identities: [owner] });
    try {
      const ownerId = (await call(api2, { url: "/v1/me", token: owner.token })).json<{
        user: string;
      }>().user;
      const committed = await commitStrategy(api2, owner);
      await seedExecution(api2, ownerId, committed.instance, {
        status: "confirmed",
        amountUsdc: "10",
      });
      await seedExecution(api2, ownerId, committed.instance, {
        status: "refunded",
        amountUsdc: "5",
      });
      await seedExecution(api2, ownerId, committed.instance, {
        status: "pending",
        amountUsdc: "3",
      });
      const response = await call(api2, {
        url: `/v1/instances/${committed.instance}/executions/summary`,
        token: owner.token,
      });
      expect(response.statusCode).toBe(200);
      const body = parsed(summarySchema, response.json());
      expect(body.orders.total).toBe(3);
      expect(body.spend.settled).toBe("10");
      expect(body.spend.returned).toBe("5");
      expect(body.spend.in_flight).toBe("3");
      // Caps count every admitted order, including ones later cancelled, reverted or returned;
      // returned funds do not give back headroom. The response states that rather than leaving
      // a user to work out why their remaining budget did not go back up.
      expect(body.spend.cap_notice).toContain("Returned funds do not give back cap headroom");
      expect(body.spend.currency).toBe("USDC");
      expect(body.spend.decimals).toBe(6);
      // Every money figure is a decimal string at USDC precision, never a JSON number.
      for (const value of [
        body.spend.settled,
        body.spend.returned,
        body.spend.in_flight,
        body.spend.remaining,
        body.spend.admitted,
      ])
        expect(fractionDigits(value)).toBeLessThanOrEqual(6);
    } finally {
      await api2.close();
    }
  }, 60_000);

  test("the refusal window is declared, never presented as lifetime truth", async () => {
    const body = parsed(
      summarySchema,
      (
        await call(api, {
          url: `/v1/instances/${strategy.instance}/executions/summary`,
          token: alice.token,
        })
      ).json(),
    );
    expect(body.refusals.window.secs).toBe(7 * 86_400);
    expect(Date.parse(body.refusals.window.until)).toBeGreaterThan(
      Date.parse(body.refusals.window.since),
    );
    expect(body.refusals.window.note).toContain("not over the strategy's lifetime");
  });
});

describe("GET /v1/instances/:id/executions", () => {
  test("scoped to one strategy, with the same item shape as the global list", async () => {
    const response = await call(api, {
      url: `/v1/instances/${strategy.instance}/executions`,
      token: alice.token,
    });
    expect(response.statusCode).toBe(200);
    const page = parsed(pageOf(executionListItemSchema), response.json());
    for (const item of page.items) expect(item.instance).toBe(strategy.instance);
    // The enriched shape is a superset of what this path used to return, which is what lets
    // apps/web keep working across the swap.
    const global = parsed(
      pageOf(executionListItemSchema),
      (
        await call(api, {
          url: `/v1/executions?instance=${strategy.instance}&limit=100`,
          token: alice.token,
        })
      ).json(),
    );
    expect(new Set(page.items.map((item) => item.id)).size).toBe(page.items.length);
    expect(global.items.length).toBeGreaterThanOrEqual(page.items.length);
  });
});
