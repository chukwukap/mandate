import { expect, test } from "bun:test";
import type { Quote } from "../../../packages/contracts/src/index.js";
import type { SettledLeg } from "../../../packages/execution/src/reconciliation/index.js";
import {
  describeRealised,
  executionQuality,
  matchSubmissions,
  realise,
  transactionCost,
} from "../../../packages/execution/src/reconciliation/index.js";
import { assetOf, FakeChainClient, ORDER, plainAsset, USDC } from "../../fixtures/chain/index.js";
import { STANDARD_ENVELOPE } from "../../fixtures/strategies/index.js";
import {
  ACCOUNT,
  boot,
  CALLS,
  CONFIRMATIONS,
  EFFECTIVE_GAS_PRICE_WEI,
  freshChain,
  L1_FEE_WEI,
  request,
  SWAP_EVIDENCE,
} from "./harness.js";

/**
 * What the order actually did, taken from the receipts and never from the quote.
 *
 * The quote is a prediction of a pool at a moment that has passed, and every way it can be
 * wrong flatters the result: it assumes the fill this order got, it ignores the gas burned
 * getting there, it ignores the gas burned on a leg that reverted, and it says nothing about an
 * order that funded and then stranded. A history built from `quote.amount_out` is a history in
 * which nothing ever goes wrong.
 *
 * So these tests take a REAL quote — through `FakeChainClient`, which runs the production
 * `selectRoute` and `minOut` over the recorded Aerodrome probes — carry it as the promise, and
 * then assert every realised number against the receipts the chain returned instead. Where the
 * two agree it is because the pool did not move; where they disagree, the receipt wins.
 */

const AAPL = assetOf("AAPLc");
const SLIPPAGE_BPS = STANDARD_ENVELOPE.caps.slippage_bps;

/** The quote the swap leg would have been built from: 250 USDC of AAPLc at 50 bps. */
async function quoteOrder(): Promise<Quote> {
  return new FakeChainClient().quote(plainAsset(AAPL), "buy", "250", SLIPPAGE_BPS);
}

const buy = {
  side: "buy" as const,
  account: ACCOUNT,
  assetToken: ORDER.token,
  assetDecimals: AAPL.decimals,
  quoteToken: USDC,
};

/** Run the legs the test names, mining each with the recorded receipt it names. */
async function runLegs(
  chain: ReturnType<typeof freshChain>,
  steps: readonly { leg: "approve" | "swap"; as: string }[],
): Promise<SettledLeg[]> {
  const settled: SettledLeg[] = [];
  for (const step of steps) {
    const worker = boot(chain.node, chain.journal);
    const prepared = await worker.prepare(request(step.leg));
    if (prepared.status !== "prepared") throw new Error(`${step.leg} did not prepare`);
    await worker.dispatch(prepared.entry, CALLS[step.leg]);
    const mined = chain.node.mine({ as: step.as });
    chain.journal.settle(
      prepared.entry.hash,
      mined.receipt.status === "success" ? "confirmed" : "reverted",
    );
    settled.push({ leg: step.leg, receipt: mined.receipt });
  }
  return settled;
}

test("the fixture venue and the fixture receipts describe the same order", async () => {
  const quote = await quoteOrder();
  expect(BigInt(quote.amount_out)).toBe(ORDER.amountOutShares);
  expect(BigInt(quote.min_out)).toBe(ORDER.minOutShares);
  expect(BigInt(quote.amount_in)).toBe(ORDER.amountInUsdc);
  expect(quote.tick_spacing).toBe(10);
});

test("a settled buy reports the fill, the price and the cost from its receipts", async () => {
  const chain = freshChain();
  const legs = await runLegs(chain, [
    { leg: "approve", as: "approve-confirmed" },
    { leg: "swap", as: "swap-confirmed" },
  ]);

  const realised = realise({ ...buy, legs });
  expect(realised.status).toBe("filled");
  expect(realised.accountSpent).toBe(ORDER.amountInUsdc);
  expect(realised.spenderCredited).toBe(0n);
  expect(realised.swapInput).toBe(ORDER.amountInUsdc);
  expect(realised.filled).toBe(ORDER.amountOutShares);
  expect(realised.residual).toBe(0n);
  expect(realised.netSpent).toBe(ORDER.amountInUsdc);
  expect(realised.price).toBe("320.220003951514848761");

  expect(describeRealised(realised, buy.assetDecimals)).toContain("0.78071325 shares");
});

test("the cost of an order includes the L1 data fee, which no gas total contains", async () => {
  const chain = freshChain();
  const legs = await runLegs(chain, [
    { leg: "approve", as: "approve-confirmed" },
    { leg: "swap", as: "swap-confirmed" },
  ]);
  const realised = realise({ ...buy, legs });
  const l2Only = legs.reduce(
    (total, entry) => total + entry.receipt.gasUsed * entry.receipt.effectiveGasPrice,
    0n,
  );
  expect(realised.gasWei).toBe(l2Only + BigInt(legs.length) * L1_FEE_WEI);
  expect(l2Only * 100n < realised.gasWei * 40n).toBe(true);
  expect(realised.gasWei - l2Only).toBe(2n * L1_FEE_WEI);
  for (const entry of legs)
    expect(realised.gasByLeg[entry.leg]).toBe(transactionCost(entry.receipt));
  expect(realised.netSpent).toBe(ORDER.amountInUsdc);
  expect(realised.gasWei).toBeGreaterThan(0n);
  expect(EFFECTIVE_GAS_PRICE_WEI).toBeGreaterThan(0n);
});

test("a fill that missed the signed floor is reported as the chain filled it, not as quoted", async () => {
  const quote = await quoteOrder();
  const chain = freshChain();
  const legs = await runLegs(chain, [
    { leg: "approve", as: "approve-confirmed" },
    { leg: "swap", as: "swap-underfilled" },
  ]);

  const realised = realise({ ...buy, legs });
  expect(realised.filled).toBe(77_290_611n);
  expect(realised.filled).not.toBe(BigInt(quote.amount_out));
  expect(BigInt(quote.amount_out) - realised.filled).toBe(780_714n);

  const quality = executionQuality({
    realised,
    quotedOut: BigInt(quote.amount_out),
    minOut: BigInt(quote.min_out),
    referencePrice: quote.reference,
  });
  expect(quality.actualOut).toBe(77_290_611n);
  expect(quality.slippageBps).toBe(101);
  expect(quality.belowFloor).toBe(true);
  expect(quality.cushionBps).toBeLessThan(0);
  expect(realised.price).toBeNull();
  expect(quality.deviationFromReferenceBps).toBeNull();
  expect(quote.reference).toBe("320.08");
});

test("a leg confirms on its transfer logs, and a shortfall is ambiguous rather than settled", async () => {
  const chain = freshChain();
  await runLegs(chain, [
    { leg: "approve", as: "approve-confirmed" },
    { leg: "swap", as: "swap-underfilled" },
  ]);
  chain.node.advance(CONFIRMATIONS);

  const rows = chain.journal.rows;
  const [approve, swap] = rows;
  if (!approve || !swap) throw new Error("two legs must be journaled");
  const { matches, unmatched } = matchSubmissions({
    entries: rows,
    receipts: chain.node.receipts(),
    head: chain.node.head,
    confirmations: CONFIRMATIONS,
    canonicalBlockHashes: chain.node.canonicalBlockHashes(),
    evidence: new Map([
      [approve.id, null],
      [swap.id, SWAP_EVIDENCE],
    ]),
    exact: new Map([[swap.id, false]]),
  });

  expect(unmatched).toEqual([]);
  expect(matches.map((match) => match.verdict.outcome)).toEqual(["confirmed", "ambiguous"]);
  expect(matches[1]?.verdict.detail).toContain(`${ORDER.minOutShares}`);
  expect(matches[1]?.changed).toBe(true);
});

test("confirmations are counted from the node's head, so a fresh receipt is not yet settled", async () => {
  const chain = freshChain();
  const worker = boot(chain.node, chain.journal);
  const prepared = await worker.prepare(request("approve"));
  if (prepared.status !== "prepared") throw new Error("the fund leg must prepare");
  await worker.dispatch(prepared.entry, CALLS.approve);
  chain.node.mine({ as: "approve-confirmed" });

  const facts = {
    entries: chain.journal.rows,
    receipts: chain.node.receipts(),
    confirmations: CONFIRMATIONS,
    evidence: new Map(),
  };
  const fresh = matchSubmissions({ ...facts, head: chain.node.head }).matches[0];
  expect(fresh?.verdict.outcome).toBe("pending");
  expect(fresh?.verdict.depth).toBe(1);

  chain.node.advance(CONFIRMATIONS - 1);
  const buried = matchSubmissions({ ...facts, head: chain.node.head }).matches[0];
  expect(buried?.verdict.outcome).toBe("confirmed");
  expect(buried?.verdict.depth).toBe(CONFIRMATIONS);
});

test("a reverted swap spends no USDC but still costs wallet gas", async () => {
  const chain = freshChain();
  const legs = await runLegs(chain, [
    { leg: "approve", as: "approve-confirmed" },
    { leg: "swap", as: "swap-reverted" },
  ]);
  const realised = realise({ ...buy, legs });
  expect(realised.filled).toBe(0n);
  expect(realised.price).toBeNull();
  expect(realised.accountSpent).toBe(0n);
  expect(realised.netSpent).toBe(0n);
  expect(realised.residual).toBe(0n);
  expect(realised.returned).toBe(0n);
  expect(realised.gasWei).toBe(legs.reduce((sum, leg) => sum + transactionCost(leg.receipt), 0n));
  expect(realised.gasByLeg.swap).toBeGreaterThan(0n);
  expect(chain.journal.rows.map((row) => row.leg)).toEqual(["approve", "swap"]);
});

test("an in-flight swap remains unsettled until a receipt is available", async () => {
  const chain = freshChain();
  const sent = await chain.worker.submit(request("swap"));
  expect(sent.status).toBe("broadcast");
  expect(chain.node.receipts()).toEqual([]);
  const result = matchSubmissions({
    entries: chain.journal.rows,
    receipts: [],
    head: chain.node.head,
    confirmations: CONFIRMATIONS,
    evidence: new Map(),
  });
  expect(result.matches[0]?.verdict.outcome).toBe("pending");
  expect(chain.journal.rows[0]?.status).toBe("signed");
});
