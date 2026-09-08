import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { RecoveryChain, RecoveryLogger } from "../src/recovery/index.js";
import { Recovery } from "../src/recovery/index.js";

/**
 * The recovery orchestrator, which is the piece that was missing.
 *
 * `diagnosis.ts` decides what to do and has its own tests. What is checked here is that the
 * decision is CARRIED OUT — because for the life of this project it was not: nothing constructed
 * any of `recovery/`, so an order in `recovery_required` sat there forever while
 * `Worker.cycle` kept blocking admissions for every owner in the fleet.
 *
 * The failure mode these guard against is worse than a bug: recovery touches money that is
 * mid-flight, and a pass that acts on a wrong reading spends it twice or returns it to nobody.
 * So the rules are that it never invents bytes, never clears an order the diagnosis did not
 * declare clearable, and never leaves an instance halted for a fault it has resolved.
 */

const SPENDER = `0x${"aa".repeat(20)}` as const;

function log(): RecoveryLogger & { lines: { level: string; msg: string }[] } {
  const lines: { level: string; msg: string }[] = [];
  const push = (level: string) => (_obj: object, msg?: string) =>
    lines.push({ level, msg: msg ?? "" });
  return {
    lines,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

type Row = {
  id: string;
  leg: string;
  status: string;
  nonce: number;
  signer: string;
  hash: string;
  createdAt: Date;
  rawTransaction: string;
};

function transaction(over: Partial<Row> = {}): Row {
  return {
    id: randomUUID(),
    leg: "fund",
    status: "signed",
    nonce: 7,
    signer: SPENDER,
    hash: `0x${"11".repeat(32)}`,
    createdAt: new Date(Date.now() - 10 * 60_000),
    rawTransaction: "0xdead",
    ...over,
  };
}

/** A store that records writes instead of performing them. */
function store(journal: Row[]) {
  const writes: string[] = [];
  const recorder = {
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          writes.push(JSON.stringify(v));
          return Promise.resolve();
        },
      }),
    }),
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  };
  return {
    writes,
    store: {
      journal: async () => journal,
      write: async (_user: string, fn: (tx: unknown) => Promise<unknown>) => fn(recorder),
    } as never,
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: () => ({ limit: async () => [] }) }),
          orderBy: () => ({ limit: async () => [] }),
        }),
      }),
    } as never,
  };
}

function chain(observed: string, sent: string[] = [], nonce = 0): RecoveryChain {
  return {
    client: {
      // 0 by default so `foreignActivity` sees nothing anomalous: with no journal rows in the
      // stub the ceiling is 0, and `latest > ceiling` is what accuses the key of foreign use.
      getTransactionCount: async () => nonce,
      getBlockNumber: async () => 100n,
    } as never,
    observe: async () => observed as never,
    broadcast: async (t) => {
      sent.push(t.hash);
    },
  };
}

const order = {
  id: randomUUID(),
  userId: randomUUID(),
  instanceId: randomUUID(),
  status: "recovery_required",
  stage: "fund",
} as never;

test("a receipt the crash lost is recorded, and the order is released", async () => {
  // The crash repair. Bytes are journaled before broadcast, so a crash between sending and
  // writing the status loses the RECORD of the receipt, never the transaction. Recovery writes
  // what the chain says happened — the one journal mutation the schema permits.
  const row = transaction();
  const { store: s, db, writes } = store([row]);
  const lines = log();
  await new Recovery({
    store: s,
    db,
    chain: chain("confirmed"),
    log: lines,
    spender: SPENDER,
    receiptTimeoutMs: 1_800_000,
  }).run(order);

  expect(writes.some((w) => w.includes("confirmed"))).toBe(true);
  // Cleared to `paused`, not `armed`: the fault interrupted something, and re-arming is the
  // owner's decision. Leaving the instance halted for a resolved fault is the other failure.
  expect(writes.some((w) => w.includes("paused"))).toBe(true);
  expect(lines.lines.some((l) => l.msg.includes("cleared"))).toBe(true);
});

test("a journal signed by another key is escalated, never acted on", async () => {
  // If the journal's signer is not the configured spender, no chain fact can be attributed to
  // this worker — so every other reading is meaningless and nothing may be automated.
  const sent: string[] = [];
  const { store: s, db, writes } = store([transaction({ signer: `0x${"bb".repeat(20)}` })]);
  const lines = log();
  await new Recovery({
    store: s,
    db,
    chain: chain("pending", sent),
    log: lines,
    spender: SPENDER,
    receiptTimeoutMs: 1_800_000,
  }).run(order);

  expect(sent).toEqual([]);
  expect(writes).toEqual([]);
  expect(lines.lines.some((l) => l.level === "error" && l.msg.includes("operator"))).toBe(true);
});

test("an RPC outage is a safe no-op, not a guess", async () => {
  // Every read degrades to "unknown" rather than to a value: `observe` to `unavailable` and
  // `nonceState` to null. A half-finished recovery is indistinguishable from the fault it was
  // trying to fix, so an unreadable chain has to leave the order exactly where it was.
  const { store: s, db, writes } = store([transaction()]);
  const lines = log();
  const broken: RecoveryChain = {
    client: {
      getTransactionCount: async () => {
        throw new Error("rpc down");
      },
      // Present and failing, not absent. `nonceState` builds a Promise.all over all three; a
      // missing method throws synchronously before that array exists, which leaves the other
      // two rejections unhandled — a fault in the stub, not in the code under test.
      getBlockNumber: async () => {
        throw new Error("rpc down");
      },
    } as never,
    observe: async () => {
      throw new Error("rpc down");
    },
    broadcast: async () => {
      throw new Error("rpc down");
    },
  };
  await new Recovery({
    store: s,
    db,
    chain: broken,
    log: lines,
    spender: SPENDER,
    receiptTimeoutMs: 1_800_000,
  }).run(order);

  // Nothing written, nothing sent, and `run` did not throw — the worker cycle has to survive a
  // recovery pass that could not read the chain.
  expect(writes).toEqual([]);
  expect(lines.lines.length).toBeGreaterThan(0);
});
