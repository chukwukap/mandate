import { expect, test } from "bun:test";
import {
  L1_FEE_ALLOWANCE_WEI,
  LEG_GAS_LIMITS,
  retryable,
} from "../../../packages/execution/src/submission/index.js";
import { boot, CALLS, freshChain, OWNER_ID, request } from "./harness.js";

/**
 * The pipeline against a node that remembers, and a journal that refuses.
 *
 * Every property here needs state that outlives one call: a nonce consumed by one leg is the
 * nonce the next leg plans around, a resend is only free because the node recognises the bytes
 * it already holds, and a duplicated job is only harmless because a UNIQUE index rejects the
 * second write. A stub that answers a scripted list can be made to agree with any of those
 * without them being true.
 */

/**
 * The same swap leg, re-quoted.
 *
 * A second attempt at a swap does not produce the same calldata: the quote carries a fresh
 * deadline and a fresh `amountOutMinimum`, so the bytes differ. That is what makes a duplicated
 * job dangerous — two DIFFERENT transactions at one nonce, of which the chain picks one
 * arbitrarily — and it is why the safety argument is about signing rather than about sending.
 */
const REQUOTED_SWAP = { ...CALLS.swap, data: "0x04e45aaf01" } as const;

/** Walk one leg to a settled receipt, the way the lifecycle does across several polls. */
async function settleLeg(
  chain: ReturnType<typeof freshChain>,
  leg: "fund" | "approve" | "swap",
  fixture: string,
) {
  const prepared = await chain.worker.prepare(request(leg));
  if (prepared.status !== "prepared") throw new Error(`${leg} did not prepare`);
  const sent = await chain.worker.dispatch(prepared.entry, CALLS[leg]);
  if (sent.status !== "broadcast") throw new Error(`${leg} was not broadcast`);
  chain.node.mine({ as: fixture });
  chain.journal.settle(prepared.entry.hash, "confirmed");
  return prepared.entry;
}

test("a buy walks fund, approve and swap up one key's nonces, journaling each before sending", async () => {
  const chain = freshChain();
  const { node, journal } = chain;

  const fund = await settleLeg(chain, "fund", "fund-confirmed");
  expect(fund.nonce).toBe(0);
  const approve = await settleLeg(chain, "approve", "approve-confirmed");
  expect(approve.nonce).toBe(1);

  // The swap is journaled and not yet sent. Asserted between the two halves rather than after,
  // because "the row exists before the bytes leave" is only observable in this window.
  const swap = await chain.worker.prepare(request("swap"));
  expect(swap.status).toBe("prepared");
  if (swap.status !== "prepared") throw new Error("unreachable");
  expect(swap.entry.nonce).toBe(2);
  expect(journal.rows).toHaveLength(3);
  expect(node.sends).toHaveLength(2);
  expect(await chain.worker.dispatch(swap.entry, CALLS.swap)).toEqual({
    status: "broadcast",
    entry: swap.entry,
  });

  expect(journal.rows.map((row) => `${row.leg}@${row.nonce}`)).toEqual([
    "fund@0",
    "approve@1",
    "swap@2",
  ]);
  // Every row is attributed to the owner the request named. `transactions.user_id` is what row
  // level security keys on, so a row written under the wrong owner is invisible to exactly the
  // tenant whose recovery depends on finding it.
  expect([...journal.owners.values()]).toEqual([OWNER_ID, OWNER_ID, OWNER_ID]);
  // Three legs, three signatures, three transactions. Nothing was signed twice and nothing was
  // sent that had not been journaled first.
  expect(node.signatures).toHaveLength(3);
  expect(node.accepted).toHaveLength(3);
  // Simulated on both sides of every durable write: before signing, and again immediately
  // before the broadcast, because the gap between them is where a quote deadline expires.
  expect(node.simulations).toHaveLength(6);
});

test("a second order waits rather than queueing behind an unsettled leg on the shared key", async () => {
  const chain = freshChain();
  const prepared = await chain.worker.prepare(request("fund"));
  if (prepared.status !== "prepared") throw new Error("the first order must prepare");
  await chain.worker.dispatch(prepared.entry, CALLS.fund);

  // One key signs for every order and every owner, so this is another user's strategy, not a
  // retry of the same one.
  const other = await chain.worker.prepare(
    request("fund", { executionId: "order-nvda-9", userId: "user-2" }),
  );
  expect(other.status).toBe("refused");
  if (other.status !== "refused") throw new Error("unreachable");
  expect(other.refusal.code).toBe("nonce-conflict");
  expect(other.refusal.detail).toContain("unsettled fund transaction at nonce 0");
  // Nothing was signed for the second order, so there is no second row to reconcile and no
  // second draw against anybody's spend permission.
  expect(chain.node.signatures).toHaveLength(1);
  expect(chain.journal.rows).toHaveLength(1);

  // It proceeds once the first leg settles, at the next nonce.
  chain.node.mine({ as: "fund-confirmed" });
  chain.journal.settle(prepared.entry.hash, "confirmed");
  const retried = await chain.worker.prepare(
    request("fund", { executionId: "order-nvda-9", userId: "user-2" }),
  );
  expect(retried.status).toBe("prepared");
  if (retried.status !== "prepared") throw new Error("unreachable");
  expect(retried.entry.nonce).toBe(1);
});

test("a leg that would revert is refused before signing, and the refusal consumes nothing", async () => {
  const chain = freshChain();
  const { node, journal } = chain;

  // The user revoked their spend permission between admission and funding, so
  // SpendPermissionManager rejects the pull. (Production surfaces that as a custom error; the
  // decoded-string path is used here because what is under test is the pipeline's response,
  // not the decoder, which `packages/execution/test` pins on its own.)
  node.revertsNext("SpendPermission is revoked");
  const refused = await chain.worker.submit(request("fund"));
  expect(refused.status).toBe("refused");
  if (refused.status !== "refused") throw new Error("unreachable");
  expect(refused.refusal.code).toBe("would-revert");
  expect(refused.refusal.detail).toContain("SpendPermission is revoked");
  // Terminal on purpose. A revert is the chain saying this transaction is invalid against
  // current state; a timer cannot change that, and retrying a `fund` on one would burn gas
  // and spend-permission attempts while the user watches an order fail silently.
  expect(retryable(refused.refusal.code)).toBe(false);
  expect(node.signatures).toHaveLength(0);
  expect(node.sends).toHaveLength(0);
  expect(journal.rows).toHaveLength(0);

  // Because nothing was consumed, the order is re-preparable from scratch the moment the state
  // that caused the revert changes — the user re-grants, and the next cycle signs at nonce 0.
  const prepared = await chain.worker.prepare(request("fund"));
  expect(prepared.status).toBe("prepared");
  if (prepared.status !== "prepared") throw new Error("unreachable");
  expect(prepared.entry.nonce).toBe(0);
});

test("a duplicated job cannot produce two swaps, because the journal admits one row per leg", async () => {
  const chain = freshChain({ baseNonce: 2 });
  const { node, journal } = chain;

  // Both workers reach `record` before either commits: the queue delivered the same
  // `execute-intent` twice and two runs picked it up. Without the latch this test would really
  // be sequential, and the second run would find the first one's row — a different property.
  journal.pause();
  const first = boot(node, journal).prepare(request("swap"));
  const second = boot(node, journal).prepare(request("swap", { call: REQUOTED_SWAP }));
  journal.resume();
  const [a, b] = await Promise.all([first, second]);

  const outcomes = [a.status, b.status].sort();
  expect(outcomes).toEqual(["prepared", "refused"]);
  const winner = a.status === "prepared" ? a : b.status === "prepared" ? b : null;
  const loser = a.status === "refused" ? a : b.status === "refused" ? b : null;
  if (winner?.status !== "prepared" || loser?.status !== "refused")
    throw new Error("exactly one of the two runs must have committed");

  // The loser signed real bytes and lost at the UNIQUE index, which is where this has to be
  // decided: two processes that both believe they are the leader cannot be separated in
  // application code, and the constraint lives in PostgreSQL where a crashed process cannot
  // take it with it.
  expect(loser.refusal.code).toBe("not-recorded");
  expect(node.signatures).toHaveLength(2);
  expect(journal.rows).toHaveLength(1);
  // A `RecordedSubmission` is the only thing `dispatch` accepts, and the loser has none — the
  // ordering is a type error rather than a review comment.
  expect(await chain.worker.dispatch(winner.entry, CALLS.swap)).toMatchObject({
    status: "broadcast",
  });
  expect(node.accepted).toHaveLength(1);
  expect(node.transactionsAtNonce(2)).toBe(1);

  // And if a process ignored the refusal anyway, the node is the last line: different bytes at
  // an occupied nonce are refused rather than racing the first ones into a block.
  const orphan = node.signatures.find((entry) => entry.hash !== winner.entry.hash);
  if (!orphan) throw new Error("the loser's bytes must exist to be rejected");
  await expect(node.send(orphan.rawTransaction)).rejects.toThrow(/underpriced/);
});

test("a duplicate delivered after the commit resends the committed bytes", async () => {
  const chain = freshChain();
  const { node, journal } = chain;

  const first = await chain.worker.submit(request("fund"));
  expect(first.status).toBe("broadcast");

  // The same job again, minutes later, while the receipt is still pending. This is the steady
  // state of a worker waiting for confirmations, not an error.
  const again = await boot(node, journal).submit(request("fund"));
  expect(again.status).toBe("broadcast");
  expect(node.signatures).toHaveLength(1);
  expect(node.sends).toHaveLength(2);
  expect(node.accepted).toHaveLength(1);
  expect(journal.rows).toHaveLength(1);
});

test("a broadcast that fails on transport keeps the bytes, and the retry sends the same ones", async () => {
  const chain = freshChain();
  const { node, journal } = chain;

  const prepared = await chain.worker.prepare(request("fund"));
  if (prepared.status !== "prepared") throw new Error("the fund leg must prepare");
  node.sendFailsNext("socket hang up");
  const failed = await chain.worker.dispatch(prepared.entry, CALLS.fund);
  expect(failed.status).toBe("refused");
  if (failed.status !== "refused") throw new Error("unreachable");
  expect(failed.refusal.code).toBe("chain-unavailable");
  // The one refusal in this file that a timer clears: the transaction is fine, the pipe was not.
  expect(retryable(failed.refusal.code)).toBe(true);
  expect(journal.rows).toHaveLength(1);
  expect(node.accepted).toHaveLength(0);

  const retried = await chain.worker.dispatch(prepared.entry, CALLS.fund);
  expect(retried.status).toBe("broadcast");
  expect(node.signatures).toHaveLength(1);
  expect(node.accepted).toHaveLength(1);
});

test("an unavailable simulation defers the broadcast rather than sending blind", async () => {
  const chain = freshChain();
  const prepared = await chain.worker.prepare(request("swap"));
  if (prepared.status !== "prepared") throw new Error("the swap leg must prepare");

  // A rate limit or a timeout is an unanswered question, never an answer of "no". The bytes
  // stay journaled and valid: waiting costs nothing, and sending blind might cost a revert.
  chain.node.unavailableNext();
  const deferred = await chain.worker.dispatch(prepared.entry, CALLS.swap);
  expect(deferred.status).toBe("refused");
  if (deferred.status !== "refused") throw new Error("unreachable");
  expect(deferred.refusal.code).toBe("simulation-unavailable");
  expect(retryable(deferred.refusal.code)).toBe(true);
  expect(chain.node.sends).toHaveLength(0);

  expect((await chain.worker.dispatch(prepared.entry, CALLS.swap)).status).toBe("broadcast");
  expect(chain.node.accepted).toHaveLength(1);
});

test("a key that cannot pay for the unwind never starts the sequence", async () => {
  // Enough ETH for the funding transaction and nothing else. That is precisely the balance
  // that strands a user: the pull succeeds, and then the swap cannot run, the allowance cannot
  // be reset and the input cannot be returned, so the money sits in the spender wallet until an
  // operator tops the key up by hand.
  const oneLeg = LEG_GAS_LIMITS.fund * 100_000_000n + L1_FEE_ALLOWANCE_WEI;
  const chain = freshChain({ balanceWei: oneLeg, maxFeePerGas: 100_000_000n });

  const refused = await chain.worker.submit(request("fund"));
  expect(refused.status).toBe("refused");
  if (refused.status !== "refused") throw new Error("unreachable");
  expect(refused.refusal.code).toBe("insufficient-gas");
  expect(refused.refusal.detail).toContain("fund, approve, swap, reset, refund");
  // Checked before the simulation and before signing, so an order that cannot be finished is
  // never started even when it would have executed perfectly.
  expect(chain.node.simulations).toHaveLength(0);
  expect(chain.node.signatures).toHaveLength(0);
  expect(chain.journal.rows).toHaveLength(0);

  // The same balance is ample once the only obligation left is the refund itself: refusing to
  // return a user's money over gas for a transaction that will never be signed would be worse
  // than the shortfall.
  const returning = await chain.worker.prepare(request("refund"));
  expect(returning.status).toBe("prepared");
});
