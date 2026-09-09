/**
 * Direct-wallet crash recovery: durable approval/swap bytes survive worker restarts.
 * Resends retain their hash and nonce; a stale signed swap blocks other orders until resolved.
 * These tests use a stateful node and journal, without submitting real transactions.
 */
import { expect, test } from "bun:test";
import { matchSubmissions } from "../../../packages/execution/src/reconciliation/index.js";
import { retryable } from "../../../packages/execution/src/submission/index.js";
import { boot, CALLS, CONFIRMATIONS, freshChain, request } from "./harness.js";

test("bytes journaled and then interrupted are resent, and the resend is not a new signature", async () => {
  const { node, journal } = freshChain();
  const first = boot(node, journal);

  const prepared = await first.prepare(request("approve"));
  expect(prepared.status).toBe("prepared");
  expect(journal.rows).toHaveLength(1);
  expect(node.sends).toHaveLength(0);
  const journaled = journal.rows[0];
  if (!journaled) throw new Error("the approval leg must be journaled");
  const restarted = boot(node, journal);
  const recovered = await restarted.prepare(request("approve"));
  expect(recovered.status).toBe("prepared");
  if (recovered.status !== "prepared") throw new Error("unreachable");
  expect(node.signatures).toHaveLength(1);
  expect(recovered.entry.rawTransaction).toBe(journaled.rawTransaction);
  expect(recovered.entry.hash).toBe(journaled.hash);
  expect(journal.rows).toHaveLength(1);

  const sent = await restarted.dispatch(recovered.entry, CALLS.approve);
  expect(sent.status).toBe("broadcast");
  expect(node.accepted).toHaveLength(1);
  expect(node.transactionsAtNonce(0)).toBe(1);
});

test("a crash after the broadcast resends the same bytes, and the node counts them once", async () => {
  const { node, journal } = freshChain();
  const worker = boot(node, journal);

  const prepared = await worker.prepare(request("approve"));
  if (prepared.status !== "prepared") throw new Error("the approval leg must prepare");
  expect((await worker.dispatch(prepared.entry, CALLS.approve)).status).toBe("broadcast");
  expect(node.pooled(prepared.entry.hash)).toBe(true);
  const restarted = boot(node, journal);
  const again = await restarted.prepare(request("approve"));
  expect(again.status).toBe("prepared");
  if (again.status !== "prepared") throw new Error("unreachable");
  expect(again.entry.hash).toBe(prepared.entry.hash);
  expect((await restarted.dispatch(again.entry, CALLS.approve)).status).toBe("broadcast");

  expect(node.sends).toHaveLength(2);
  expect(node.accepted).toHaveLength(1);
  expect(node.signatures).toHaveLength(1);
  expect(node.transactionsAtNonce(0)).toBe(1);
});

test("a transaction that reached the chain while the worker was down is found by its hash", async () => {
  const { node, journal } = freshChain();
  const worker = boot(node, journal);

  const prepared = await worker.prepare(request("approve"));
  if (prepared.status !== "prepared") throw new Error("the approval leg must prepare");
  await worker.dispatch(prepared.entry, CALLS.approve);
  node.mine({ as: "approve-confirmed" });
  node.advance(CONFIRMATIONS - 1);

  const restarted = boot(node, journal);
  const blocked = await restarted.prepare(request("approve"));
  expect(blocked.status).toBe("refused");
  if (blocked.status !== "refused") throw new Error("unreachable");
  expect(blocked.refusal.code).toBe("nonce-conflict");
  expect(blocked.refusal.detail).toContain("receipt");
  expect(retryable(blocked.refusal.code)).toBe(false);
  expect(node.signatures).toHaveLength(1);
  expect(node.sends).toHaveLength(1);
  const row = journal.rows[0];
  if (!row) throw new Error("the approval leg must be journaled");
  const { matches, unmatched } = matchSubmissions({
    entries: journal.rows,
    receipts: node.receipts(),
    head: node.head,
    confirmations: CONFIRMATIONS,
    canonicalBlockHashes: node.canonicalBlockHashes(),
    signerLatestNonce: 1,
    evidence: new Map(),
  });
  const match = matches[0];
  expect(matches).toHaveLength(1);
  expect(unmatched).toHaveLength(0);
  expect(match?.receipt?.transactionHash).toBe(row.hash);
  expect(match?.verdict.outcome).toBe("confirmed");
  expect(match?.receipt?.status).toBe("success");
  expect(match?.changed).toBe(false);
  journal.settle(row.hash, "confirmed");
  const approve = await restarted.prepare(request("swap"));
  expect(approve.status).toBe("prepared");
  if (approve.status !== "prepared") throw new Error("unreachable");
  expect(approve.entry.nonce).toBe(1);
  expect(node.transactionsAtNonce(0)).toBe(1);
  expect(journal.rows.map((entry) => `${entry.leg}:${entry.status}`)).toEqual([
    "approve:confirmed",
    "swap:signed",
  ]);
});

test("a crash before the journal commit leaves nothing on the chain and no gap in the nonces", async () => {
  const { node, journal } = freshChain();
  const worker = boot(node, journal);

  journal.failNextRecord();
  const lost = await worker.prepare(request("approve"));
  expect(lost.status).toBe("refused");
  if (lost.status !== "refused") throw new Error("unreachable");
  expect(lost.refusal.code).toBe("not-recorded");
  expect(node.signatures).toHaveLength(1);
  expect(node.sends).toHaveLength(0);
  expect(journal.rows).toHaveLength(0);

  const restarted = boot(node, journal);
  const retried = await restarted.prepare(request("approve"));
  expect(retried.status).toBe("prepared");
  if (retried.status !== "prepared") throw new Error("unreachable");
  expect(retried.entry.nonce).toBe(0);
  expect(node.signatures).toHaveLength(2);
  expect(journal.rows).toHaveLength(1);

  await restarted.dispatch(retried.entry, CALLS.approve);
  expect(node.accepted).toHaveLength(1);
  expect(node.transactionsAtNonce(0)).toBe(1);
});

test("journaled swap bytes that go stale during a crash block the key instead of paying for a revert", async () => {
  const { node, journal } = freshChain();
  const worker = boot(node, journal);

  const approved = await worker.prepare(request("approve"));
  if (approved.status !== "prepared") throw new Error("the approve leg must prepare");
  await worker.dispatch(approved.entry, CALLS.approve);
  node.mine({ as: "approve-confirmed" });
  journal.settle(approved.entry.hash, "confirmed");

  const swap = await worker.prepare(request("swap"));
  expect(swap.status).toBe("prepared");
  if (swap.status !== "prepared") throw new Error("unreachable");
  const restarted = boot(node, journal);
  const recovered = await restarted.prepare(request("swap"));
  if (recovered.status !== "prepared") throw new Error("the swap leg must be recovered");
  node.revertsNext("Too little received");
  const refused = await restarted.dispatch(recovered.entry, CALLS.swap);

  expect(refused.status).toBe("refused");
  if (refused.status !== "refused") throw new Error("unreachable");
  expect(refused.refusal.code).toBe("stale-submission");
  expect(refused.refusal.detail).toContain("Too little received");
  expect(refused.refusal.detail).toContain(`nonce ${recovered.entry.nonce}`);
  expect(retryable(refused.refusal.code)).toBe(false);
  expect(node.sends).toHaveLength(1); // approval only
  expect(journal.rows).toHaveLength(2);
  expect(journal.find("swap")?.status).toBe("signed");
  const nextOrder = await restarted.prepare(request("swap", { executionId: "another-order" }));
  expect(nextOrder.status).toBe("refused");
  if (nextOrder.status !== "refused") throw new Error("unreachable");
  expect(nextOrder.refusal.code).toBe("nonce-conflict");
  expect(nextOrder.refusal.detail).toContain("unsettled swap transaction");
  expect(node.signatures).toHaveLength(2);
});

test("a restart cannot invent a second approval transaction however many times it happens", async () => {
  const { node, journal } = freshChain();
  const first = boot(node, journal);
  const prepared = await first.prepare(request("approve"));
  if (prepared.status !== "prepared") throw new Error("the approval leg must prepare");
  for (let restart = 0; restart < 10; restart += 1) {
    const worker = boot(node, journal);
    const recovered = await worker.prepare(request("approve"));
    expect(recovered.status).toBe("prepared");
    if (recovered.status !== "prepared") throw new Error("unreachable");
    expect(recovered.entry.hash).toBe(prepared.entry.hash);
    expect((await worker.dispatch(recovered.entry, CALLS.approve)).status).toBe("broadcast");
  }

  expect(node.signatures).toHaveLength(1);
  expect(node.sends).toHaveLength(10);
  expect(node.accepted).toHaveLength(1);
  expect(node.transactionsAtNonce(0)).toBe(1);
  expect(journal.rows).toHaveLength(1);

  node.mine({ as: "approve-confirmed" });
  node.advance(CONFIRMATIONS - 1);
  const row = journal.rows[0];
  if (!row) throw new Error("the approval leg must be journaled");
  const { matches } = matchSubmissions({
    entries: journal.rows,
    receipts: node.receipts(),
    head: node.head,
    confirmations: CONFIRMATIONS,
    evidence: new Map(),
  });
  expect(node.receipts()).toHaveLength(1);
  expect(matches[0]?.verdict.outcome).toBe("confirmed");
});
