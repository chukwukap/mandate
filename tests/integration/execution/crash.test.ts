import { expect, test } from "bun:test";
import { matchSubmissions } from "../../../packages/execution/src/reconciliation/index.js";
import { retryable } from "../../../packages/execution/src/submission/index.js";
import { ORDER } from "../../fixtures/chain/index.js";
import { boot, CALLS, CONFIRMATIONS, FUND_EVIDENCE, freshChain, request } from "./harness.js";

/**
 * What survives a process dying mid-order.
 *
 * The funding leg pulls a user's USDC into a wallet this service controls, so the two failures
 * either side of the durable write are not symmetric and neither is recoverable by guessing:
 *
 *  - A transaction that was BROADCAST AND NOT RECORDED mines with nobody watching. There is no
 *    row, no hash to look for and no order to return the money against; the USDC simply arrives
 *    in the spender wallet. Nothing downstream can find it, because finding it requires knowing
 *    what to look for.
 *  - A transaction that was RECORDED AND NOT BROADCAST costs nothing, and the correct response
 *    to finding one is the same as the correct response to a successful prepare: send what is in
 *    the journal.
 *
 * That asymmetry is why `record` precedes `send`, and every test below is an attempt to break
 * the pipeline by killing it at the worst available moment. A "crash" here is `boot()` — a new
 * `Submitter` over the same journal and the same node — because a `Submitter` holds nothing
 * across a call: if recovery needed anything that lived only in the dead process's memory, these
 * would fail.
 *
 * The count that matters in almost every one of them is `node.signatures.length`. Re-signing is
 * the only way this system can produce two different transactions at one nonce, and two
 * different `fund` transactions at one nonce is two attempts to pull the same user's money.
 */

test("bytes journaled and then interrupted are resent, and the resend is not a new signature", async () => {
  const { node, journal } = freshChain();
  const first = boot(node, journal);

  const prepared = await first.prepare(request("fund"));
  expect(prepared.status).toBe("prepared");
  // The commit point. Signed bytes are durable and nothing has reached the node.
  expect(journal.rows).toHaveLength(1);
  expect(node.sends).toHaveLength(0);
  const journaled = journal.rows[0];
  if (!journaled) throw new Error("the fund leg must be journaled");

  // The process dies here. The journal is the only surviving state.
  const restarted = boot(node, journal);
  const recovered = await restarted.prepare(request("fund"));
  expect(recovered.status).toBe("prepared");
  if (recovered.status !== "prepared") throw new Error("unreachable");

  // Byte-identical, because they were never re-signed: `planNonce` recognised our own
  // unsettled row for this order and leg and returned it instead of choosing a nonce.
  expect(node.signatures).toHaveLength(1);
  expect(recovered.entry.rawTransaction).toBe(journaled.rawTransaction);
  expect(recovered.entry.hash).toBe(journaled.hash);
  expect(journal.rows).toHaveLength(1);

  const sent = await restarted.dispatch(recovered.entry, CALLS.fund);
  expect(sent.status).toBe("broadcast");
  // One transaction reached the chain, and only one ever could: the node holds one set of
  // bytes at nonce 0 and the journal holds one row for (order, fund).
  expect(node.accepted).toHaveLength(1);
  expect(node.transactionsAtNonce(0)).toBe(1);
});

test("a crash after the broadcast resends the same bytes, and the node counts them once", async () => {
  const { node, journal } = freshChain();
  const worker = boot(node, journal);

  const prepared = await worker.prepare(request("fund"));
  if (prepared.status !== "prepared") throw new Error("the fund leg must prepare");
  expect((await worker.dispatch(prepared.entry, CALLS.fund)).status).toBe("broadcast");
  expect(node.pooled(prepared.entry.hash)).toBe(true);

  // Dead between the send and the status write: the order still says nothing happened while
  // the transaction sits in a mempool. This is the state a worker restarts into most often.
  const restarted = boot(node, journal);
  const again = await restarted.prepare(request("fund"));
  expect(again.status).toBe("prepared");
  if (again.status !== "prepared") throw new Error("unreachable");
  // `pending` exceeds `latest` here — our own transaction is in the pool. Reading that as
  // foreign activity would halt the worker every time it had just done its job correctly.
  expect(again.entry.hash).toBe(prepared.entry.hash);
  expect((await restarted.dispatch(again.entry, CALLS.fund)).status).toBe("broadcast");

  expect(node.sends).toHaveLength(2);
  // Two sends, one transaction. Identical bytes are one transaction; that is what makes
  // recovery a resend rather than a decision.
  expect(node.accepted).toHaveLength(1);
  expect(node.signatures).toHaveLength(1);
  expect(node.transactionsAtNonce(0)).toBe(1);
});

test("a transaction that reached the chain while the worker was down is found by its hash", async () => {
  const { node, journal } = freshChain();
  const worker = boot(node, journal);

  const prepared = await worker.prepare(request("fund"));
  if (prepared.status !== "prepared") throw new Error("the fund leg must prepare");
  await worker.dispatch(prepared.entry, CALLS.fund);

  // The process dies, and while it is down the funding transaction mines and is buried. The
  // user's USDC has moved and nothing has recorded that it did.
  node.mine({ as: "fund-confirmed" });
  node.advance(CONFIRMATIONS - 1);

  const restarted = boot(node, journal);
  const blocked = await restarted.prepare(request("fund"));
  // The nonce is consumed and the row is still `signed`. That is not "pending" and not
  // "confirmed": something mined at that nonce and only a receipt says what. Signing anything
  // here would be a second pull against the spend permission.
  expect(blocked.status).toBe("refused");
  if (blocked.status !== "refused") throw new Error("unreachable");
  expect(blocked.refusal.code).toBe("nonce-conflict");
  expect(blocked.refusal.detail).toContain("receipt");
  expect(retryable(blocked.refusal.code)).toBe(false);
  expect(node.signatures).toHaveLength(1);
  expect(node.sends).toHaveLength(1);

  // The receipt read that answers it. Matching is by hash and by nothing else: the nonce is a
  // slot, and the whole question here is whether our bytes or somebody else's occupied it.
  const row = journal.rows[0];
  if (!row) throw new Error("the fund leg must be journaled");
  const { matches, unmatched } = matchSubmissions({
    entries: journal.rows,
    receipts: node.receipts(),
    head: node.head,
    confirmations: CONFIRMATIONS,
    canonicalBlockHashes: node.canonicalBlockHashes(),
    signerLatestNonce: 1,
    evidence: new Map([[row.id, FUND_EVIDENCE]]),
  });
  const match = matches[0];
  expect(matches).toHaveLength(1);
  expect(unmatched).toHaveLength(0);
  expect(match?.receipt?.transactionHash).toBe(row.hash);
  // Confirmed on the strength of the Transfer log, not on the strength of `status: success`:
  // exactly the authorised USDC, out of the user's own account, into the spender wallet.
  expect(match?.verdict.outcome).toBe("confirmed");
  expect(match?.verdict.detail).toContain("matching transfer evidence");
  expect(match?.changed).toBe(false);

  // Only now may the order advance, and it advances at the next nonce rather than re-using one
  // the chain has consumed.
  journal.settle(row.hash, "confirmed");
  const approve = await restarted.prepare(request("approve"));
  expect(approve.status).toBe("prepared");
  if (approve.status !== "prepared") throw new Error("unreachable");
  expect(approve.entry.nonce).toBe(1);
  expect(node.transactionsAtNonce(0)).toBe(1);
  expect(journal.rows.map((entry) => `${entry.leg}:${entry.status}`)).toEqual([
    "fund:confirmed",
    "approve:signed",
  ]);
});

test("a crash before the journal commit leaves nothing on the chain and no gap in the nonces", async () => {
  const { node, journal } = freshChain();
  const worker = boot(node, journal);

  journal.failNextRecord();
  const lost = await worker.prepare(request("fund"));
  expect(lost.status).toBe("refused");
  if (lost.status !== "refused") throw new Error("unreachable");
  expect(lost.refusal.code).toBe("not-recorded");
  // Bytes were produced and then discarded, which is the correct direction: nothing that was
  // not journaled may ever reach a node, because nothing could find it afterwards.
  expect(node.signatures).toHaveLength(1);
  expect(node.sends).toHaveLength(0);
  expect(journal.rows).toHaveLength(0);

  const restarted = boot(node, journal);
  const retried = await restarted.prepare(request("fund"));
  expect(retried.status).toBe("prepared");
  if (retried.status !== "prepared") throw new Error("unreachable");
  // The same nonce, not the next one. A retry that skipped a nonce would leave a gap no later
  // transaction from this key could mine past.
  expect(retried.entry.nonce).toBe(0);
  expect(node.signatures).toHaveLength(2);
  expect(journal.rows).toHaveLength(1);

  await restarted.dispatch(retried.entry, CALLS.fund);
  // Two signatures existed at nonce 0 over the order's life; exactly one of them was durable
  // and exactly one reached the chain.
  expect(node.accepted).toHaveLength(1);
  expect(node.transactionsAtNonce(0)).toBe(1);
});

test("journaled swap bytes that go stale during a crash block the key instead of paying for a revert", async () => {
  const { node, journal } = freshChain();
  const worker = boot(node, journal);

  const funded = await worker.prepare(request("fund"));
  if (funded.status !== "prepared") throw new Error("the fund leg must prepare");
  await worker.dispatch(funded.entry, CALLS.fund);
  node.mine({ as: "fund-confirmed" });
  journal.settle(funded.entry.hash, "confirmed");

  const approved = await worker.prepare(request("approve"));
  if (approved.status !== "prepared") throw new Error("the approve leg must prepare");
  await worker.dispatch(approved.entry, CALLS.approve);
  node.mine({ as: "approve-confirmed" });
  journal.settle(approved.entry.hash, "confirmed");

  const swap = await worker.prepare(request("swap"));
  expect(swap.status).toBe("prepared");
  if (swap.status !== "prepared") throw new Error("unreachable");

  // The process dies before the broadcast. By the time it comes back the pool has moved and
  // these bytes — which carry the quote's deadline and `amountOutMinimum` — no longer execute.
  const restarted = boot(node, journal);
  const recovered = await restarted.prepare(request("swap"));
  if (recovered.status !== "prepared") throw new Error("the swap leg must be recovered");
  node.revertsNext("Too little received");
  const refused = await restarted.dispatch(recovered.entry, CALLS.swap);

  expect(refused.status).toBe("refused");
  if (refused.status !== "refused") throw new Error("unreachable");
  // Not `would-revert`: these bytes are already durable and their nonce is already spoken for,
  // so the remedy is heavier and an operator has to see it.
  expect(refused.refusal.code).toBe("stale-submission");
  expect(refused.refusal.detail).toContain("Too little received");
  expect(refused.refusal.detail).toContain(`nonce ${recovered.entry.nonce}`);
  expect(retryable(refused.refusal.code)).toBe(false);
  expect(node.sends).toHaveLength(2); // fund and approve only

  // The row survives and it blocks the key: the refund leg that would return the user's USDC
  // cannot be signed while an unsettled swap owns nonce 2. That is the uncomfortable half of
  // the ordering, and it is deliberate — a silent broadcast or a silently abandoned row would
  // trade a visible stall for a paid revert or a lost transaction.
  expect(journal.rows).toHaveLength(3);
  expect(journal.find("swap")?.status).toBe("signed");
  const refund = await restarted.prepare(request("refund"));
  expect(refund.status).toBe("refused");
  if (refund.status !== "refused") throw new Error("unreachable");
  expect(refund.refusal.code).toBe("nonce-conflict");
  expect(refund.refusal.detail).toContain("unsettled swap transaction");
  expect(node.signatures).toHaveLength(3);
});

test("a restart cannot invent a second funding transaction however many times it happens", async () => {
  const { node, journal } = freshChain();
  const first = boot(node, journal);
  const prepared = await first.prepare(request("fund"));
  if (prepared.status !== "prepared") throw new Error("the fund leg must prepare");

  // Ten supervisor restarts, each one preparing and dispatching the leg from scratch. A worker
  // that re-signed on any of them would have produced ten `fund` transactions competing for
  // one nonce, each of them a draw against the user's spend permission.
  for (let restart = 0; restart < 10; restart += 1) {
    const worker = boot(node, journal);
    const recovered = await worker.prepare(request("fund"));
    expect(recovered.status).toBe("prepared");
    if (recovered.status !== "prepared") throw new Error("unreachable");
    expect(recovered.entry.hash).toBe(prepared.entry.hash);
    expect((await worker.dispatch(recovered.entry, CALLS.fund)).status).toBe("broadcast");
  }

  expect(node.signatures).toHaveLength(1);
  expect(node.sends).toHaveLength(10);
  expect(node.accepted).toHaveLength(1);
  expect(node.transactionsAtNonce(0)).toBe(1);
  expect(journal.rows).toHaveLength(1);

  node.mine({ as: "fund-confirmed" });
  node.advance(CONFIRMATIONS - 1);
  const row = journal.rows[0];
  if (!row) throw new Error("the fund leg must be journaled");
  const { matches } = matchSubmissions({
    entries: journal.rows,
    receipts: node.receipts(),
    head: node.head,
    confirmations: CONFIRMATIONS,
    evidence: new Map([[row.id, FUND_EVIDENCE]]),
  });
  // One receipt, and it moved the order's amount exactly once. Ten broadcasts of one
  // transaction pull 250 USDC, not 2,500.
  expect(node.receipts()).toHaveLength(1);
  expect(matches[0]?.verdict.outcome).toBe("confirmed");
  expect(ORDER.amountInUsdc).toBe(250_000_000n);
});
