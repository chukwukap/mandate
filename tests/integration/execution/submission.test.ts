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
  leg: "approve" | "swap",
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

test("a buy walks approve and swap up one key's nonces, journaling each before sending", async () => {
  const chain = freshChain();
  const { node, journal } = chain;

  const approve = await settleLeg(chain, "approve", "approve-confirmed");
  expect(approve.nonce).toBe(0);
  const swap = await chain.worker.prepare(request("swap"));
  expect(swap.status).toBe("prepared");
  if (swap.status !== "prepared") throw new Error("unreachable");
  expect(swap.entry.nonce).toBe(1);
  expect(journal.rows).toHaveLength(2);
  expect(node.sends).toHaveLength(1);
  expect(await chain.worker.dispatch(swap.entry, CALLS.swap)).toEqual({
    status: "broadcast",
    entry: swap.entry,
  });

  expect(journal.rows.map((row) => `${row.leg}@${row.nonce}`)).toEqual(["approve@0", "swap@1"]);
  expect([...journal.owners.values()]).toEqual([OWNER_ID, OWNER_ID]);
  expect(node.signatures).toHaveLength(2);
  expect(node.accepted).toHaveLength(2);
  expect(node.simulations).toHaveLength(4);
});

test("a second order waits rather than queueing behind an unsettled leg on the same wallet", async () => {
  const chain = freshChain();
  const prepared = await chain.worker.prepare(request("approve"));
  if (prepared.status !== "prepared") throw new Error("the first order must prepare");
  await chain.worker.dispatch(prepared.entry, CALLS.approve);
  const other = await chain.worker.prepare(
    request("approve", { executionId: "order-nvda-9", userId: OWNER_ID }),
  );
  expect(other.status).toBe("refused");
  if (other.status !== "refused") throw new Error("unreachable");
  expect(other.refusal.code).toBe("nonce-conflict");
  expect(other.refusal.detail).toContain("unsettled approve transaction at nonce 0");
  expect(chain.node.signatures).toHaveLength(1);
  expect(chain.journal.rows).toHaveLength(1);
  chain.node.mine({ as: "approve-confirmed" });
  chain.journal.settle(prepared.entry.hash, "confirmed");
  const retried = await chain.worker.prepare(
    request("approve", { executionId: "order-nvda-9", userId: OWNER_ID }),
  );
  expect(retried.status).toBe("prepared");
  if (retried.status !== "prepared") throw new Error("unreachable");
  expect(retried.entry.nonce).toBe(1);
});

test("a leg that would revert is refused before signing, and the refusal consumes nothing", async () => {
  const chain = freshChain();
  const { node, journal } = chain;
  node.revertsNext("ERC20 approval rejected");
  const refused = await chain.worker.submit(request("approve"));
  expect(refused.status).toBe("refused");
  if (refused.status !== "refused") throw new Error("unreachable");
  expect(refused.refusal.code).toBe("would-revert");
  expect(refused.refusal.detail).toContain("ERC20 approval rejected");
  expect(retryable(refused.refusal.code)).toBe(false);
  expect(node.signatures).toHaveLength(0);
  expect(node.sends).toHaveLength(0);
  expect(journal.rows).toHaveLength(0);
  const prepared = await chain.worker.prepare(request("approve"));
  expect(prepared.status).toBe("prepared");
  if (prepared.status !== "prepared") throw new Error("unreachable");
  expect(prepared.entry.nonce).toBe(0);
});

test("a duplicated job cannot produce two swaps, because the journal admits one row per leg", async () => {
  const chain = freshChain({ baseNonce: 2 });
  const { node, journal } = chain;
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
  expect(loser.refusal.code).toBe("not-recorded");
  expect(node.signatures).toHaveLength(2);
  expect(journal.rows).toHaveLength(1);
  expect(await chain.worker.dispatch(winner.entry, CALLS.swap)).toMatchObject({
    status: "broadcast",
  });
  expect(node.accepted).toHaveLength(1);
  expect(node.transactionsAtNonce(2)).toBe(1);
  const orphan = node.signatures.find((entry) => entry.hash !== winner.entry.hash);
  if (!orphan) throw new Error("the loser's bytes must exist to be rejected");
  await expect(node.send(orphan.rawTransaction)).rejects.toThrow(/underpriced/);
});

test("a duplicate delivered after the commit resends the committed bytes", async () => {
  const chain = freshChain();
  const { node, journal } = chain;

  const first = await chain.worker.submit(request("approve"));
  expect(first.status).toBe("broadcast");
  const again = await boot(node, journal).submit(request("approve"));
  expect(again.status).toBe("broadcast");
  expect(node.signatures).toHaveLength(1);
  expect(node.sends).toHaveLength(2);
  expect(node.accepted).toHaveLength(1);
  expect(journal.rows).toHaveLength(1);
});

test("a broadcast that fails on transport keeps the bytes, and the retry sends the same ones", async () => {
  const chain = freshChain();
  const { node, journal } = chain;

  const prepared = await chain.worker.prepare(request("approve"));
  if (prepared.status !== "prepared") throw new Error("the approval leg must prepare");
  node.sendFailsNext("socket hang up");
  const failed = await chain.worker.dispatch(prepared.entry, CALLS.approve);
  expect(failed.status).toBe("refused");
  if (failed.status !== "refused") throw new Error("unreachable");
  expect(failed.refusal.code).toBe("chain-unavailable");
  expect(retryable(failed.refusal.code)).toBe(true);
  expect(journal.rows).toHaveLength(1);
  expect(node.accepted).toHaveLength(0);

  const retried = await chain.worker.dispatch(prepared.entry, CALLS.approve);
  expect(retried.status).toBe("broadcast");
  expect(node.signatures).toHaveLength(1);
  expect(node.accepted).toHaveLength(1);
});

test("an unavailable simulation defers the broadcast rather than sending blind", async () => {
  const chain = freshChain();
  const prepared = await chain.worker.prepare(request("swap"));
  if (prepared.status !== "prepared") throw new Error("the swap leg must prepare");
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

test("a wallet unable to pay for both approval and swap never starts the sequence", async () => {
  const oneLeg = LEG_GAS_LIMITS.approve * 100_000_000n + L1_FEE_ALLOWANCE_WEI;
  const chain = freshChain({ balanceWei: oneLeg, maxFeePerGas: 100_000_000n });

  const refused = await chain.worker.submit(request("approve"));
  expect(refused.status).toBe("refused");
  if (refused.status !== "refused") throw new Error("unreachable");
  expect(refused.refusal.code).toBe("insufficient-gas");
  expect(refused.refusal.detail).toContain("approve, swap");
  expect(chain.node.simulations).toHaveLength(0);
  expect(chain.node.signatures).toHaveLength(0);
  expect(chain.journal.rows).toHaveLength(0);
});
