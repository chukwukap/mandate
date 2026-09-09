import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TransactionRow } from "@mandate/database";
import type { ChainFacts, RecoveryChain, RecoveryLogger } from "../src/recovery/index.js";
import { DEFAULT_REBROADCAST_AFTER_MS, diagnose, Recovery } from "../src/recovery/index.js";

/**
 * The recovery orchestrator, which is the piece that was missing.
 *
 * `diagnosis.ts` decides what to do and its table is checked at the bottom of this file. What
 * the first half checks is that the decision is CARRIED OUT — because for the life of this
 * project it was not: nothing constructed any of `recovery/`, so an order in
 * `recovery_required` sat there forever while `Worker.cycle` kept blocking admissions for
 * every owner in the fleet.
 *
 * The failure mode these guard against is worse than a bug: recovery touches money that is
 * mid-flight, and a pass that acts on a wrong reading spends it twice. So the rules are that
 * it never invents bytes, never clears an order the diagnosis did not declare clearable, and
 * never leaves an instance halted for a fault it has resolved.
 */

/** The strategy's own embedded wallet: the only signer a journal row may carry. */
const WALLET = `0x${"aa".repeat(20)}` as const;

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

function transaction(over: Partial<TransactionRow> = {}): TransactionRow {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    executionId: randomUUID(),
    leg: "approve",
    status: "signed",
    nonce: 7,
    signer: WALLET,
    hash: `0x${"11".repeat(32)}`,
    createdAt: new Date(Date.now() - 10 * 60_000),
    rawTransaction: "0xdead",
    evidence: null,
    confirmedAt: null,
    ...over,
  };
}

/** A store that records writes instead of performing them. */
function store(journal: TransactionRow[]) {
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
      // The expected signer is derived from the strategy, not configured: whichever wallet
      // the draft names is the wallet every row of its journal must have been signed by.
      context: async () => ({ draft: { account: WALLET }, instance: {}, owner: {} }),
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
      // stub the ceiling is 0, and `latest > ceiling` is what accuses the wallet of use
      // outside this journal.
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
  stage: "approve",
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
    receiptTimeoutMs: 1_800_000,
  }).run(order);

  expect(writes.some((w) => w.includes("confirmed"))).toBe(true);
  // Cleared to `paused`, not `armed`: the fault interrupted something, and re-arming is the
  // owner's decision. Leaving the instance halted for a resolved fault is the other failure.
  expect(writes.some((w) => w.includes("paused"))).toBe(true);
  expect(lines.lines.some((l) => l.msg.includes("cleared"))).toBe(true);
});

test("a journal signed by another wallet is escalated, never acted on", async () => {
  // If a row's signer is not the strategy's wallet, no chain fact can be attributed to this
  // worker — so every other reading is meaningless and nothing may be automated.
  const sent: string[] = [];
  const { store: s, db, writes } = store([transaction({ signer: `0x${"bb".repeat(20)}` })]);
  const lines = log();
  await new Recovery({
    store: s,
    db,
    chain: chain("pending", sent),
    log: lines,
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
    receiptTimeoutMs: 1_800_000,
  }).run(order);

  // Nothing written, nothing sent, and `run` did not throw — the worker cycle has to survive a
  // recovery pass that could not read the chain.
  expect(writes).toEqual([]);
  expect(lines.lines.length).toBeGreaterThan(0);
});

/**
 * The decision table, exercised without a chain or a database.
 *
 * With approve → swap from the user's own wallet there is no funded USDC parked with a worker
 * key and so no "stranded input" to return: a reverted leg leaves the money where it always
 * was. What remains to decide is whether an in-flight leg settled, whether a settled one still
 * reads the same, and whether the wallet has been used outside this journal.
 */
const policy = { receiptTimeoutMs: 1_800_000, rebroadcastAfterMs: DEFAULT_REBROADCAST_AFTER_MS };
const NOW = Date.now();
function facts(over: Partial<ChainFacts> = {}): ChainFacts {
  return {
    legs: [],
    nonce: { signer: WALLET, latest: 7, pending: 7, blockNumber: 100n },
    journal: { ceiling: 8, unsettled: [7], complete: true },
    located: null,
    signerMismatch: false,
    now: NOW,
    ...over,
  };
}
const signed = (over: Partial<TransactionRow> = {}) =>
  transaction({ createdAt: new Date(NOW - 10 * 60_000), ...over });

test("diagnosis: an unattributable signer outranks every other reading", () => {
  // A confirmed receipt that would otherwise be the crash repair is ignored when the row was
  // not signed by the strategy's wallet; nothing about it can be trusted.
  const verdict = diagnose(
    order,
    facts({ legs: [{ transaction: signed(), observed: "confirmed" }], signerMismatch: true }),
    policy,
  );
  expect(verdict.code).toBe("unattributable");
  expect(verdict.decision).toBe("escalate");
  expect(verdict.settle).toBeNull();
  expect(verdict.clearable).toBe(false);
});

test("diagnosis: a settled receipt that changed is escalated before anything in flight", () => {
  const approve = signed({ leg: "approve", status: "confirmed", nonce: 6 });
  const swap = signed({ leg: "swap", nonce: 7, hash: `0x${"22".repeat(32)}` });
  const verdict = diagnose(
    order,
    facts({
      legs: [
        { transaction: approve, observed: "reverted" },
        { transaction: swap, observed: "confirmed" },
      ],
    }),
    policy,
  );
  expect(verdict.code).toBe("receipt-changed");
  expect(verdict.decision).toBe("escalate");
  expect(verdict.transactionId).toBe(approve.id);
  expect(verdict.settle).toBeNull();
});

test("diagnosis: the fate of an in-flight leg", () => {
  const cases: {
    observed: ChainFacts["legs"][number]["observed"];
    nonce: Partial<NonNullable<ChainFacts["nonce"]>>;
    ageMs?: number;
    code: string;
    decision: string;
    settle: "confirmed" | "reverted" | null;
    clearable: boolean;
  }[] = [
    // Settled either way is the crash repair: record it and hand the order back. A reverted
    // approval or swap moved nothing, so there is no leg left to unwind before clearing.
    {
      observed: "confirmed",
      nonce: {},
      code: "settled-confirmed",
      decision: "none",
      settle: "confirmed",
      clearable: true,
    },
    {
      observed: "reverted",
      nonce: {},
      code: "settled-reverted",
      decision: "none",
      settle: "reverted",
      clearable: true,
    },
    // A consumed nonce with no receipt for our hash: the bytes can never mine and nothing
    // here may guess what did.
    {
      observed: "ambiguous",
      nonce: { latest: 8, pending: 8 },
      code: "unattributable",
      decision: "escalate",
      settle: null,
      clearable: false,
    },
    // Free nonce, node holding nothing, old enough: resend the identical bytes.
    {
      observed: "pending",
      nonce: {},
      code: "dropped-rebroadcast",
      decision: "rebroadcast",
      settle: null,
      clearable: false,
    },
    // The same reading seconds after signing is not yet a drop.
    {
      observed: "pending",
      nonce: {},
      ageMs: 5_000,
      code: "awaiting-inclusion",
      decision: "wait",
      settle: null,
      clearable: false,
    },
    // Held in the mempool and inside the timeout: nothing to do but wait.
    {
      observed: "pending",
      nonce: { pending: 8 },
      code: "awaiting-inclusion",
      decision: "wait",
      settle: null,
      clearable: false,
    },
    // An earlier nonce is unconsumed, so this transaction physically cannot be included.
    {
      observed: "pending",
      nonce: { latest: 6, pending: 6 },
      code: "blocked-by-nonce-gap",
      decision: "escalate",
      settle: null,
      clearable: false,
    },
    // The observation itself failed: neither settled nor dropped, just unknown.
    {
      observed: "unavailable",
      nonce: {},
      code: "unattributable",
      decision: "wait",
      settle: null,
      clearable: false,
    },
  ];
  for (const c of cases) {
    const row = signed({ createdAt: new Date(NOW - (c.ageMs ?? 10 * 60_000)) });
    const verdict = diagnose(
      order,
      facts({
        legs: [{ transaction: row, observed: c.observed }],
        nonce: { signer: WALLET, latest: 7, pending: 7, blockNumber: 100n, ...c.nonce },
      }),
      policy,
    );
    expect(verdict.code).toBe(c.code as typeof verdict.code);
    expect(verdict.decision).toBe(c.decision as typeof verdict.decision);
    expect(verdict.settle?.status ?? null).toBe(c.settle);
    expect(verdict.clearable).toBe(c.clearable);
    if (verdict.decision === "rebroadcast") expect(verdict.transactionId).toBe(row.id);
  }
});

test("diagnosis: activity outside the journal is the user's, and blocks clearing", () => {
  // The wallet belongs to the user, who may send from it themselves. A consumed nonce this
  // worker never journaled, or a pending one no row explains, means the nonce arithmetic
  // every other verdict rests on no longer describes the wallet.
  const consistent = diagnose(
    order,
    facts({
      legs: [{ transaction: signed({ status: "confirmed" }), observed: "confirmed" }],
      nonce: { signer: WALLET, latest: 8, pending: 8, blockNumber: 100n },
      journal: { ceiling: 8, unsettled: [], complete: true },
    }),
    policy,
  );
  expect(consistent.code).toBe("journal-consistent");
  expect(consistent.clearable).toBe(true);

  const foreign = diagnose(
    order,
    facts({
      legs: [{ transaction: signed({ status: "confirmed" }), observed: "confirmed" }],
      nonce: { signer: WALLET, latest: 9, pending: 9, blockNumber: 100n },
      journal: { ceiling: 8, unsettled: [], complete: true },
    }),
    policy,
  );
  expect(foreign.code).toBe("foreign-signer-activity");
  expect(foreign.decision).toBe("escalate");
  expect(foreign.clearable).toBe(false);

  // A truncated owner scan is "cannot tell", never an accusation: the ceiling is a lower
  // bound, and clearing on a lower bound would be a guess about the user's own wallet.
  const partial = diagnose(
    order,
    facts({
      legs: [{ transaction: signed({ status: "confirmed" }), observed: "confirmed" }],
      nonce: { signer: WALLET, latest: 9, pending: 9, blockNumber: 100n },
      journal: { ceiling: 8, unsettled: [], complete: false },
    }),
    policy,
  );
  expect(partial.code).toBe("journal-consistent");

  // The crash repair does not clear over foreign activity either: the receipt is recorded,
  // but the order stays with an operator.
  const repaired = diagnose(
    order,
    facts({
      legs: [{ transaction: signed(), observed: "confirmed" }],
      nonce: { signer: WALLET, latest: 9, pending: 9, blockNumber: 100n },
      journal: { ceiling: 8, unsettled: [7], complete: true },
    }),
    policy,
  );
  expect(repaired.settle?.status).toBe("confirmed");
  expect(repaired.clearable).toBe(false);
});
