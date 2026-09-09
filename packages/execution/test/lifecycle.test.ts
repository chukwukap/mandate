import { expect, test } from "bun:test";
import type {
  DraftRow,
  ExecutionRow,
  InstanceRow,
  Transaction,
  TransactionRow,
  WorkerStore,
} from "@mandate/database";
import { schema } from "@mandate/database";
import {
  type Context,
  type Executor,
  type Leg,
  Lifecycle,
  type Observation,
  type Prepared,
  RecoveryRequired,
} from "../src/lifecycle.js";

/**
 * The order's state machine, driven from the journal and nothing else.
 *
 * Two legs, approve then swap, both signed by the user's own wallet. What these tests pin is
 * not the happy path — it is short — but the decisions at the edges: that bytes are journaled
 * before anything could reach a node, that a user who paused is not signed for, that a reverted
 * leg ends the order rather than being retried into a second fee, and that anything the chain
 * cannot explain stops the strategy for a person instead of guessing.
 *
 * The store is faked at the level of the writes the lifecycle makes, because those writes ARE
 * the behaviour: a real database would only confirm that drizzle can persist a row.
 */

const USER = "00000000-0000-4000-8000-000000000001";
const INSTANCE = "00000000-0000-4000-8000-000000000011";
const ORDER = "00000000-0000-4000-8000-000000000013";
const WALLET = "0x1111111111111111111111111111111111111111";
const OWNER = { id: USER, privyDid: "did:privy:alice" };
const TIMEOUT_MS = 60_000;

type Write = { table: unknown; values: Record<string, unknown> };

/** Just enough of a drizzle transaction for the two statements the lifecycle issues. */
function fakeTx(writes: Write[]): Transaction {
  return {
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          writes.push({ table, values });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        writes.push({ table, values });
      },
    }),
  } as unknown as Transaction;
}

function instance(over: Partial<InstanceRow> = {}): InstanceRow {
  const now = new Date();
  return {
    id: INSTANCE,
    userId: USER,
    draftId: "00000000-0000-4000-8000-000000000010",
    name: "Demo",
    mode: "auto",
    status: "armed",
    haltReason: null,
    signature: "0xsig",
    runtime: {} as never,
    tickIntervalMs: 12_000,
    createdAt: now,
    updatedAt: now,
    nextTickAt: now,
    lastTickAt: null,
    eligibleCountry: "NG",
    eligibilityExpiresAt: null,
    ...over,
  };
}

function draft(expiresAt = "2030-01-01T00:00:00.000Z"): DraftRow {
  return { envelope: { caps: { expires_at: expiresAt } } } as unknown as DraftRow;
}

function order(over: Partial<ExecutionRow> = {}): ExecutionRow {
  const now = new Date();
  return {
    id: ORDER,
    userId: USER,
    instanceId: INSTANCE,
    status: "admitted",
    tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokenOut: "0xb200000000000000000000C2e324d24d7eEcd1fb",
    amountIn: "100000000",
    txHash: null,
    reason: null,
    createdAt: now,
    updatedAt: now,
    intent: null,
    stage: "approve",
    ...over,
  };
}

function journaled(leg: Leg, status: string, over: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: `t-${leg}`,
    userId: USER,
    executionId: ORDER,
    leg,
    signer: WALLET,
    nonce: leg === "approve" ? 7 : 8,
    rawTransaction: `0x02f8-${leg}`,
    hash: `0x${(leg === "approve" ? "aa" : "bb").repeat(32)}`,
    status,
    evidence: null,
    createdAt: new Date(),
    confirmedAt: status === "signed" ? null : new Date(),
    ...over,
  };
}

class FakeStore {
  rows: TransactionRow[] = [];
  writes: Write[] = [];
  instance = instance();
  draft = draft();
  /** What the row lock sees. Differs from `instance` when consent changed under the order. */
  locked: InstanceRow | undefined;
  journalReads = 0;
  async write<T>(_user: string, run: (tx: Transaction) => Promise<T>): Promise<T> {
    return run(fakeTx(this.writes));
  }
  async journal() {
    this.journalReads += 1;
    return this.rows;
  }
  async context(): Promise<Context> {
    return { instance: this.instance, draft: this.draft, owner: OWNER };
  }
  async lockInstance() {
    return this.locked ?? this.instance;
  }
  /** The last values written to a table, so an assertion reads like the row it produced. */
  last(table: unknown) {
    return this.writes.filter((write) => write.table === table).at(-1)?.values;
  }
}

class FakeChain implements Executor {
  observations = new Map<string, Observation>();
  prepared: Leg[] = [];
  contexts: Context[] = [];
  sent: string[] = [];
  failPrepare: "unsafe" | "refused" | undefined;
  async prepare(leg: Leg, _order: ExecutionRow, context: Context): Promise<Prepared> {
    this.prepared.push(leg);
    this.contexts.push(context);
    if (this.failPrepare === "unsafe") throw new RecoveryRequired("nonce state unexplained");
    if (this.failPrepare === "refused") throw new Error("quote outside band");
    return {
      signer: WALLET,
      nonce: 7 + this.prepared.length,
      rawTransaction: `0x02f8-${leg}`,
      hash: `0x${"cc".repeat(32)}`,
      evidence: null,
    };
  }
  async observe(transaction: TransactionRow): Promise<Observation> {
    return this.observations.get(transaction.hash) ?? "pending";
  }
  async broadcast(transaction: TransactionRow) {
    this.sent.push(transaction.rawTransaction);
  }
}

function harness() {
  const store = new FakeStore();
  const chain = new FakeChain();
  const lifecycle = new Lifecycle(store as unknown as WorkerStore, chain, TIMEOUT_MS);
  return { store, chain, lifecycle };
}

test("a fresh order approves first, and journals the bytes without broadcasting them", async () => {
  const { store, chain, lifecycle } = harness();
  await lifecycle.run(order());
  expect(chain.prepared).toEqual(["approve"]);
  expect(store.last(schema.transactions)).toMatchObject({
    executionId: ORDER,
    userId: USER,
    leg: "approve",
    signer: WALLET,
    rawTransaction: "0x02f8-approve",
  });
  expect(store.last(schema.executions)).toMatchObject({ status: "pending", stage: "approve" });
  // The journal row lands before the execution advances, so a crash between the two leaves an
  // order that still points at a leg the journal can account for.
  expect(store.writes.map((write) => write.table)).toEqual([
    schema.transactions,
    schema.executions,
  ]);
  // Nothing is sent from this pass: only a subsequent read of the durable row may broadcast,
  // which is what makes "signed but not journaled" an unreachable state.
  expect(chain.sent).toEqual([]);
});

test("a confirmed approval is followed by the swap, and a confirmed swap ends the order", async () => {
  const first = harness();
  first.store.rows = [journaled("approve", "confirmed")];
  first.chain.observations.set(journaled("approve", "confirmed").hash, "confirmed");
  await first.lifecycle.run(order());
  expect(first.chain.prepared).toEqual(["swap"]);
  expect(first.store.last(schema.transactions)).toMatchObject({ leg: "swap" });
  expect(first.store.last(schema.executions)).toMatchObject({ status: "pending", stage: "swap" });

  const second = harness();
  second.store.rows = [journaled("approve", "confirmed"), journaled("swap", "confirmed")];
  for (const row of second.store.rows) second.chain.observations.set(row.hash, "confirmed");
  await second.lifecycle.run(order({ status: "pending", stage: "swap" }));
  expect(second.chain.prepared).toEqual([]);
  expect(second.store.last(schema.executions)).toMatchObject({
    status: "confirmed",
    stage: "done",
    reason: null,
  });
});

test("journaled bytes still pending are resent, never re-signed", async () => {
  const { store, chain, lifecycle } = harness();
  const pending = journaled("approve", "signed");
  store.rows = [pending];
  await lifecycle.run(order({ status: "pending" }));
  expect(chain.sent).toEqual([pending.rawTransaction]);
  expect(chain.prepared).toEqual([]);
  // Resending is idempotent at the node; a second signature at a fresh nonce would not be.
  expect(store.last(schema.transactions)).toBeUndefined();
  expect(store.last(schema.executions)).toBeUndefined();
});

test("a receipt settles the journal row and leaves the next leg to the next poll", async () => {
  for (const observed of ["confirmed", "reverted"] as const) {
    const { store, chain, lifecycle } = harness();
    const pending = journaled("approve", "signed");
    store.rows = [pending];
    chain.observations.set(pending.hash, observed);
    await lifecycle.run(order({ status: "pending" }));
    expect(store.last(schema.transactions)).toMatchObject({ status: observed });
    expect(store.last(schema.transactions)?.confirmedAt).toBeInstanceOf(Date);
    expect(store.last(schema.executions)).toMatchObject({ txHash: pending.hash });
    // The status is not decided in the same pass as the receipt is recorded: the next leg is
    // derived from the durable row, so a crash after this write changes nothing.
    expect(store.last(schema.executions)?.status).toBeUndefined();
    expect(chain.prepared).toEqual([]);
    expect(chain.sent).toEqual([]);
  }
});

test("a reverted leg ends the order as reverted, at the leg that reverted", async () => {
  const approval = harness();
  approval.store.rows = [journaled("approve", "reverted")];
  approval.chain.observations.set(approval.store.rows[0]?.hash ?? "", "reverted");
  await approval.lifecycle.run(order({ status: "pending" }));
  expect(approval.store.last(schema.executions)).toMatchObject({
    status: "reverted",
    stage: "approve",
    reason: "Approval reverted",
  });

  const swap = harness();
  swap.store.rows = [journaled("approve", "confirmed"), journaled("swap", "reverted")];
  swap.chain.observations.set(swap.store.rows[0]?.hash ?? "", "confirmed");
  swap.chain.observations.set(swap.store.rows[1]?.hash ?? "", "reverted");
  await swap.lifecycle.run(order({ status: "pending", stage: "swap" }));
  expect(swap.store.last(schema.executions)).toMatchObject({
    status: "reverted",
    stage: "swap",
    reason: "Swap reverted",
  });
  // Nothing left the wallet, so nothing is retried and nobody is paged: the next tick may
  // admit a fresh order if the rule still holds.
  for (const h of [approval, swap]) {
    expect(h.chain.prepared).toEqual([]);
    expect(h.store.last(schema.instances)).toBeUndefined();
  }
});

test("a strategy that is no longer armed cancels before anything is signed", async () => {
  const withdrawn: Array<Partial<FakeStore>> = [
    { instance: instance({ status: "paused" }) },
    { instance: instance({ mode: "manual" }) },
    { draft: draft("2020-01-01T00:00:00.000Z") },
  ];
  for (const change of withdrawn) {
    const { store, chain, lifecycle } = harness();
    Object.assign(store, change);
    await lifecycle.run(order());
    expect(chain.prepared).toEqual([]);
    expect(store.last(schema.executions)).toMatchObject({
      status: "cancelled",
      stage: "approve",
      reason: "Strategy no longer armed",
    });
  }
  // A pause after the approval confirmed cancels at the swap: consent was withdrawn for the
  // transfer, and the router allowance the approval left behind moves nothing by itself.
  const late = harness();
  late.store.instance = instance({ status: "paused" });
  late.store.rows = [journaled("approve", "confirmed")];
  late.chain.observations.set(late.store.rows[0]?.hash ?? "", "confirmed");
  await late.lifecycle.run(order({ status: "pending" }));
  expect(late.store.last(schema.executions)).toMatchObject({ status: "cancelled", stage: "swap" });
});

test("consent withdrawn between the read and the row lock is a no-op, not a signature", async () => {
  const { store, chain, lifecycle } = harness();
  // The API paused the instance after the lifecycle read its context but before it locked
  // the row. `updatedAt` moved, which is the whole reason the lock re-reads it.
  store.locked = instance({ status: "paused", updatedAt: new Date(Date.now() + 1) });
  await lifecycle.run(order());
  // The transaction was prepared — that is the cost of checking late — but never journaled,
  // so nothing can ever broadcast it.
  expect(chain.prepared).toEqual(["approve"]);
  expect(store.last(schema.transactions)).toBeUndefined();
  expect(store.last(schema.executions)).toBeUndefined();
});

test("a transaction the chain cannot explain halts the strategy for an operator", async () => {
  const stale = harness();
  const old = journaled("approve", "signed", { createdAt: new Date(Date.now() - TIMEOUT_MS - 1) });
  stale.store.rows = [old];
  await stale.lifecycle.run(order({ status: "pending" }));
  expect(stale.chain.sent).toEqual([]);
  expect(stale.store.last(schema.executions)).toMatchObject({
    status: "recovery_required",
    stage: "approve",
  });
  expect(stale.store.last(schema.instances)).toMatchObject({ status: "halted" });
  expect(stale.store.last(schema.instances)?.haltReason).toContain("inspect journal");

  const ambiguous = harness();
  const fresh = journaled("approve", "signed");
  ambiguous.store.rows = [fresh];
  ambiguous.chain.observations.set(fresh.hash, "ambiguous");
  await ambiguous.lifecycle.run(order({ status: "pending" }));
  expect(ambiguous.store.last(schema.executions)).toMatchObject({ status: "recovery_required" });
  expect(ambiguous.chain.sent).toEqual([]);
});

test("a settled receipt that changed under the journal is an operator condition", async () => {
  const { store, chain, lifecycle } = harness();
  const settled = journaled("approve", "confirmed");
  store.rows = [settled];
  chain.observations.set(settled.hash, "reverted");
  await lifecycle.run(order({ status: "pending" }));
  expect(chain.prepared).toEqual([]);
  expect(store.last(schema.executions)).toMatchObject({
    status: "recovery_required",
    stage: "approve",
    reason: "Previously settled receipt changed",
  });
  expect(store.last(schema.instances)).toMatchObject({ status: "halted" });
});

test("a refused preparation cancels, and an unsafe one halts", async () => {
  const refused = harness();
  refused.chain.failPrepare = "refused";
  await refused.lifecycle.run(order());
  expect(refused.store.last(schema.executions)).toMatchObject({
    status: "cancelled",
    stage: "approve",
    reason: "Admission checks failed before signing",
  });
  expect(refused.store.last(schema.instances)).toBeUndefined();

  const unsafe = harness();
  unsafe.chain.failPrepare = "unsafe";
  await unsafe.lifecycle.run(order());
  expect(unsafe.store.last(schema.executions)).toMatchObject({
    status: "recovery_required",
    reason: "Cannot establish safe execution",
  });
  expect(unsafe.store.last(schema.instances)).toMatchObject({ status: "halted" });
  for (const h of [refused, unsafe]) expect(h.store.last(schema.transactions)).toBeUndefined();
});

test("an order already waiting on an operator is not touched", async () => {
  const { store, chain, lifecycle } = harness();
  await lifecycle.run(order({ status: "recovery_required" }));
  expect(store.journalReads).toBe(0);
  expect(store.writes).toEqual([]);
  expect(chain.prepared).toEqual([]);
});

test("the signer is handed the owner's Privy identity, and no permission", async () => {
  const { chain, lifecycle } = harness();
  await lifecycle.run(order());
  const context = chain.contexts[0];
  // The embedded wallet is looked up from the DID; without it the executor has nothing to
  // sign with. The retired spend permission has no place left in the context at all.
  expect(context?.owner).toEqual(OWNER);
  expect(Object.keys(context ?? {}).sort()).toEqual(["draft", "instance", "owner"]);
});
