import { expect, test } from "bun:test";
import type { Hex } from "@mandate/contracts";
import type {
  JournalEntry,
  SubmissionCall,
  SubmissionChain,
  SubmissionJournal,
} from "../src/submission/index.js";
import {
  checkGas,
  classifySimulationFailure,
  gasReserve,
  L1_FEE_ALLOWANCE_WEI,
  LEG_GAS_LIMITS,
  planNonce,
  remainingLegs,
  retryable,
  revertReason,
  Submitter,
} from "../src/submission/index.js";

const SIGNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Hex;
const CALL: SubmissionCall = { to: `0x${"11".repeat(20)}` as Hex, data: "0xabcdef01" };

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: overrides.id ?? "t1",
    executionId: overrides.executionId ?? "order-a",
    leg: overrides.leg ?? "approve",
    signer: overrides.signer ?? SIGNER,
    nonce: overrides.nonce ?? 7,
    hash: overrides.hash ?? `0x${"aa".repeat(32)}`,
    rawTransaction: overrides.rawTransaction ?? "0x02f8aa",
    status: overrides.status ?? "signed",
  };
}

const facts = (over: Partial<Parameters<typeof planNonce>[0]> = {}) =>
  planNonce({
    signer: SIGNER,
    latest: 7,
    pending: 7,
    entries: [],
    executionId: "order-a",
    leg: "approve",
    ...over,
  });

test("a clean signer signs at the latest consumed nonce", () => {
  expect(facts()).toEqual({ kind: "sign", nonce: 7 });
});

test("our own unsettled bytes are resent, never re-signed", () => {
  const own = entry({ nonce: 7 });
  const plan = facts({ entries: [own], pending: 8 });
  // pending > latest here because our own transaction is in the node's mempool. Reading
  // that as foreign activity would halt the worker every time it worked correctly.
  expect(plan).toEqual({ kind: "resend", entry: own });
});

test("an unsettled leg belonging to another order blocks this one", () => {
  const plan = facts({ entries: [entry({ executionId: "order-b", leg: "swap", nonce: 7 })] });
  expect(plan.kind).toBe("blocked");
  expect(plan.kind === "blocked" && plan.code).toBe("unsettled-leg");
});

test("a consumed nonce under an unsettled row is a receipt question, not a resend", () => {
  const plan = facts({ entries: [entry({ nonce: 6 })], latest: 7, pending: 7 });
  expect(plan.kind === "blocked" && plan.code).toBe("consumed-unsettled");
});

test("bytes stranded above a nonce gap are not resent forever", () => {
  // Nothing is ever signed above `latest`, so a journaled row above it means the chain went
  // backwards. Resending would never mine and the worker would look busy while stuck.
  const plan = facts({ entries: [entry({ nonce: 9 })], latest: 7, pending: 7 });
  expect(plan.kind === "blocked" && plan.code).toBe("journal-ahead");
});

test("a pending transaction nobody journaled stops everything", () => {
  const plan = facts({ latest: 7, pending: 9 });
  expect(plan.kind === "blocked" && plan.code).toBe("foreign-pending");
});

test("a settled row at or beyond the next free nonce is a contradiction", () => {
  const taken = facts({ entries: [entry({ nonce: 7, status: "confirmed" })] });
  expect(taken.kind === "blocked" && taken.code).toBe("nonce-taken");
  const ahead = facts({ entries: [entry({ nonce: 9, status: "confirmed" })] });
  expect(ahead.kind === "blocked" && ahead.code).toBe("journal-ahead");
});

test("a node that contradicts itself is not used to choose a nonce", () => {
  const plan = facts({ latest: 9, pending: 7 });
  expect(plan.kind === "blocked" && plan.code).toBe("inconsistent-counts");
});

test("another signer's journal rows do not constrain this key", () => {
  const other = entry({ signer: `0x${"22".repeat(20)}` as Hex, nonce: 7 });
  expect(facts({ entries: [other] })).toEqual({ kind: "sign", nonce: 7 });
});

function errorStringData(message: string): string {
  const hex = Buffer.from(message, "utf8").toString("hex");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  const offset = 32n.toString(16).padStart(64, "0");
  const length = BigInt(Buffer.byteLength(message)).toString(16).padStart(64, "0");
  return `0x08c379a0${offset}${length}${padded}`;
}

test("a revert is told apart from an unanswered question", () => {
  const revert = {
    name: "ContractFunctionExecutionError",
    cause: { data: errorStringData("STF") },
  };
  expect(classifySimulationFailure(revert)).toEqual({ kind: "reverted", detail: "STF" });
  expect(classifySimulationFailure({ code: 3, message: "execution reverted" }).kind).toBe(
    "reverted",
  );
  expect(classifySimulationFailure({ code: -32000, message: "execution reverted: STF" }).kind).toBe(
    "reverted",
  );
  expect(classifySimulationFailure({ name: "ExecutionRevertedError" }).kind).toBe("reverted");
  // A rate limit, a timeout, a 502: unknown, therefore retryable, therefore not a refusal.
  const upstream = classifySimulationFailure(new Error("fetch failed: 429 Too Many Requests"));
  expect(upstream.kind).toBe("unavailable");
  expect(retryable("simulation-unavailable")).toBe(true);
  expect(retryable("would-revert")).toBe(false);
});

test("a revert reason is decoded, bounded, or honestly reported as unresolved", () => {
  expect(revertReason(errorStringData("Too little received"))).toBe("Too little received");
  const panic = `0x4e487b71${0x11n.toString(16).padStart(64, "0")}`;
  expect(revertReason(panic)).toBe("Panic(0x11): arithmetic overflow or underflow.");
  // A custom error's signature is reported as four bytes, never guessed at.
  expect(revertReason("0xdeadbeef")).toBe("Custom error 0xdeadbeef (signature not resolved).");
  expect(revertReason("0x")).toContain("without a reason");
  // An attacker-chosen length prefix cannot make this allocate or emit an unbounded string.
  const huge = `0x08c379a0${32n.toString(16).padStart(64, "0")}${(2n ** 200n).toString(16).padStart(64, "0")}${"41".repeat(32)}`;
  expect(revertReason(huge).length).toBeLessThanOrEqual(200);
  // Control characters never reach a log line or executions.reason.
  expect(revertReason(errorStringData("a\nbc"))).toBe("a b c");
});

test("an approval is refused unless the wallet can also pay for the swap it enables", () => {
  const maxFeePerGas = 100_000_000n; // 0.1 gwei, a normal Base fee
  const approveReserve = gasReserve({ leg: "approve", maxFeePerGas });
  const swapReserve = gasReserve({ leg: "swap", maxFeePerGas });
  expect(remainingLegs("approve")).toEqual(["approve", "swap"]);
  expect(remainingLegs("swap")).toEqual(["swap"]);
  expect(approveReserve).toBeGreaterThan(swapReserve);

  // Enough for the swap alone is exactly the balance that leaves an order half done: the
  // approval succeeds, the wallet cannot then pay for the swap, and the user is left with a
  // router allowance and no shares until they top up.
  const swapAlone = LEG_GAS_LIMITS.swap * maxFeePerGas + L1_FEE_ALLOWANCE_WEI;
  const budget = checkGas({ leg: "approve", balance: swapAlone, maxFeePerGas });
  expect(budget.sufficient).toBe(false);
  expect(budget.shortfall).toBe(approveReserve - swapAlone);
  expect(budget.legs).toHaveLength(2);
  // The same balance is plenty once the approval has landed and only the swap remains.
  expect(checkGas({ leg: "swap", balance: swapAlone, maxFeePerGas }).sufficient).toBe(true);
  // The swap is the expensive leg: Slipstream crosses ticks and the B20 token runs its
  // transfer policy on every move, neither of which an approval does.
  expect(LEG_GAS_LIMITS.swap).toBeGreaterThan(LEG_GAS_LIMITS.approve);
});

test("an unreadable fee is never read as free gas", () => {
  expect(gasReserve({ leg: "approve", maxFeePerGas: 0n })).toBeGreaterThan(0n);
});

type HarnessOptions = {
  chainId?: number;
  latest?: number;
  pending?: number;
  balance?: bigint;
  simulateFailures?: (unknown | null)[];
  signNonce?: number;
  recordError?: unknown;
  sendError?: unknown;
};

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const rows: JournalEntry[] = [];
  const failures = [...(options.simulateFailures ?? [])];
  let signed = 0;
  const chain: SubmissionChain = {
    chainId: async () => options.chainId ?? 8453,
    transactionCounts: async () => ({
      latest: options.latest ?? 7,
      pending: options.pending ?? options.latest ?? 7,
    }),
    simulate: async () => {
      events.push("simulate");
      const failure = failures.shift();
      if (failure) throw failure;
    },
    balance: async () => options.balance ?? 10n ** 18n,
    maxFeePerGas: async () => 100_000_000n,
    sign: async ({ signer, nonce }) => {
      events.push("sign");
      signed += 1;
      const applied = options.signNonce ?? nonce;
      return {
        signer,
        nonce: applied,
        rawTransaction: `0x02f8${applied.toString(16).padStart(4, "0")}` as Hex,
        hash: `0x${applied.toString(16).padStart(64, "0")}` as Hex,
      };
    },
    send: async () => {
      events.push("send");
      if (options.sendError) throw options.sendError;
    },
  };
  const journal: SubmissionJournal = {
    entries: async () => rows,
    record: async ({ executionId, leg, signed: bytes }) => {
      events.push("record");
      if (options.recordError) throw options.recordError;
      // Stands in for UNIQUE (signer, nonce) and UNIQUE (execution_id, leg).
      if (
        rows.some((row) => row.signer === bytes.signer && row.nonce === bytes.nonce) ||
        rows.some((row) => row.executionId === executionId && row.leg === leg)
      )
        throw new Error("unique violation");
      const row: JournalEntry = {
        id: `t${rows.length + 1}`,
        executionId,
        leg,
        signer: bytes.signer,
        nonce: bytes.nonce,
        hash: bytes.hash,
        rawTransaction: bytes.rawTransaction,
        status: "signed",
      };
      rows.push(row);
      return { ...row, recorded: true };
    },
  };
  const request = {
    executionId: "order-a",
    userId: "user-a",
    leg: "approve" as const,
    signer: SIGNER,
    call: CALL,
  };
  return {
    events,
    rows,
    request,
    signCount: () => signed,
    submitter: new Submitter(chain, journal),
  };
}

test("bytes are journaled before they are broadcast, and simulated on both sides of that", async () => {
  const h = harness();
  const result = await h.submitter.submit(h.request);
  expect(result.status).toBe("broadcast");
  expect(h.events).toEqual(["simulate", "sign", "record", "simulate", "send"]);
  expect(h.events.indexOf("record")).toBeLessThan(h.events.indexOf("send"));
  expect(h.rows).toHaveLength(1);
});

test("a crash between the journal write and the broadcast resends, it does not re-sign", async () => {
  const h = harness();
  const prepared = await h.submitter.prepare(h.request);
  expect(prepared.status).toBe("prepared");
  expect(h.events).toEqual(["simulate", "sign", "record"]);
  expect(h.rows).toHaveLength(1);

  // The process dies here. On the next cycle the same order is prepared again; the journal
  // is the only surviving state.
  const again = await h.submitter.prepare(h.request);
  expect(again.status).toBe("prepared");
  expect(h.signCount()).toBe(1);
  expect(h.rows).toHaveLength(1);
  if (again.status !== "prepared") throw new Error("unreachable");
  expect(again.entry.rawTransaction).toBe(h.rows[0]?.rawTransaction ?? "");
  const sent = await h.submitter.dispatch(again.entry);
  expect(sent.status).toBe("broadcast");
});

test("a transaction that would revert is never sent", async () => {
  const h = harness({ simulateFailures: [{ code: 3, message: "execution reverted" }] });
  const result = await h.submitter.submit(h.request);
  expect(result.status).toBe("refused");
  if (result.status !== "refused") throw new Error("unreachable");
  expect(result.refusal.code).toBe("would-revert");
  expect(retryable(result.refusal.code)).toBe(false);
  expect(h.events).not.toContain("send");
  expect(h.events).not.toContain("sign");
  expect(h.rows).toHaveLength(0);
});

test("journaled bytes that now revert block the key instead of burning gas", async () => {
  // The realistic cause: a swap carries the quote's 20s deadline, and the broadcast happens
  // on a later poll. Sending it anyway pays for a guaranteed revert.
  const h = harness({ simulateFailures: [null, { code: 3, message: "execution reverted" }] });
  const result = await h.submitter.submit(h.request);
  expect(result.status).toBe("refused");
  if (result.status !== "refused") throw new Error("unreachable");
  expect(result.refusal.code).toBe("stale-submission");
  expect(result.refusal.detail).toContain("nonce 7");
  expect(h.events).not.toContain("send");
  // The row survives: it is durable, its nonce is spoken for, and an operator resolves it.
  expect(h.rows).toHaveLength(1);
});

test("an unavailable pre-broadcast simulation defers rather than sending blind", async () => {
  const h = harness({ simulateFailures: [null, new Error("fetch failed")] });
  const result = await h.submitter.submit(h.request);
  expect(result.status).toBe("refused");
  if (result.status !== "refused") throw new Error("unreachable");
  expect(result.refusal.code).toBe("simulation-unavailable");
  expect(retryable(result.refusal.code)).toBe(true);
  expect(h.events).not.toContain("send");
});

test("a journal write that fails takes the transaction with it", async () => {
  const h = harness({ recordError: new Error("deadlock detected") });
  const result = await h.submitter.submit(h.request);
  expect(result.status).toBe("refused");
  if (result.status !== "refused") throw new Error("unreachable");
  expect(result.refusal.code).toBe("not-recorded");
  expect(h.events).toEqual(["simulate", "sign", "record"]);
  expect(h.events).not.toContain("send");
});

test("signing at a nonce other than the one planned discards the bytes unrecorded", async () => {
  const h = harness({ signNonce: 11 });
  const result = await h.submitter.submit(h.request);
  expect(result.status).toBe("refused");
  if (result.status !== "refused") throw new Error("unreachable");
  expect(result.refusal.code).toBe("nonce-conflict");
  expect(h.events).not.toContain("record");
  expect(h.rows).toHaveLength(0);
});

test("nothing is signed against an RPC serving another chain", async () => {
  const h = harness({ chainId: 84532 });
  const result = await h.submitter.submit(h.request);
  expect(result.status).toBe("refused");
  if (result.status !== "refused") throw new Error("unreachable");
  expect(result.refusal.code).toBe("wrong-network");
  expect(h.events).toEqual([]);
});

test("a node that already holds identical bytes has accepted them", async () => {
  const h = harness({ sendError: new Error("already known") });
  const result = await h.submitter.submit(h.request);
  expect(result.status).toBe("broadcast");
});

test("a nonce that has already mined hands the question to reconciliation", async () => {
  const h = harness({ sendError: new Error("nonce too low") });
  // Whether our bytes or someone else's consumed the nonce is a receipt question. Reporting
  // it as broadcast lets the receipt read answer it instead of guessing here.
  expect((await h.submitter.submit(h.request)).status).toBe("broadcast");
});

test("a different transaction occupying our nonce is a conflict, not a retry", async () => {
  const h = harness({ sendError: new Error("replacement transaction underpriced") });
  const result = await h.submitter.submit(h.request);
  expect(result.status).toBe("refused");
  if (result.status !== "refused") throw new Error("unreachable");
  expect(result.refusal.code).toBe("nonce-conflict");
});

test("a broadcast that fails on transport keeps the bytes for the next cycle", async () => {
  const h = harness({ sendError: new Error("socket hang up") });
  const result = await h.submitter.submit(h.request);
  expect(result.status).toBe("refused");
  if (result.status !== "refused") throw new Error("unreachable");
  expect(result.refusal.code).toBe("chain-unavailable");
  expect(retryable(result.refusal.code)).toBe(true);
  expect(h.rows).toHaveLength(1);
});

test("a wallet that cannot afford both legs never starts the sequence", async () => {
  const h = harness({ balance: 1n });
  const result = await h.submitter.submit(h.request);
  expect(result.status).toBe("refused");
  if (result.status !== "refused") throw new Error("unreachable");
  expect(result.refusal.code).toBe("insufficient-gas");
  expect(h.events).not.toContain("sign");
});
