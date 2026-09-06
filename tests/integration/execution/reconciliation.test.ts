import { expect, test } from "bun:test";
import type { Quote } from "../../../packages/contracts/src/index.js";
import { custodial, custody } from "../../../packages/execution/src/keys/custody.js";
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
  FUND_EVIDENCE,
  freshChain,
  L1_FEE_WEI,
  request,
  SPENDER,
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
  spender: SPENDER,
  assetToken: ORDER.token,
  // EVERY B20 equity is 8 decimals. Eighteen here misprices the fill by 10^10 and produces a
  // number plausible enough to store.
  assetDecimals: AAPL.decimals,
  quoteToken: USDC,
};

/** Run the legs the test names, mining each with the recorded receipt it names. */
async function runLegs(
  chain: ReturnType<typeof freshChain>,
  steps: readonly { leg: "fund" | "approve" | "swap" | "reset" | "refund"; as: string }[],
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
  // The recorded pool at tick spacing 10 fills 250 USDC into 0.78071325 AAPLc, and the signed
  // floor 50 bps under it is what the receipt fixtures were built against. If these ever drift,
  // every "the fill beat/missed the floor" assertion below would be measuring nothing.
  expect(BigInt(quote.amount_out)).toBe(ORDER.amountOutShares);
  expect(BigInt(quote.min_out)).toBe(ORDER.minOutShares);
  expect(BigInt(quote.amount_in)).toBe(ORDER.amountInUsdc);
  expect(quote.tick_spacing).toBe(10);
});

test("a settled buy reports the fill, the price and the cost from its receipts", async () => {
  const chain = freshChain();
  const legs = await runLegs(chain, [
    { leg: "fund", as: "fund-confirmed" },
    { leg: "approve", as: "approve-confirmed" },
    { leg: "swap", as: "swap-confirmed" },
  ]);

  const realised = realise({ ...buy, legs });
  expect(realised.status).toBe("filled");
  // Every one of these comes from a Transfer log, not from calldata and not from the quote.
  expect(realised.accountSpent).toBe(ORDER.amountInUsdc);
  expect(realised.spenderCredited).toBe(ORDER.amountInUsdc);
  expect(realised.swapInput).toBe(ORDER.amountInUsdc);
  expect(realised.filled).toBe(ORDER.amountOutShares);
  // Zero residual: everything this order pulled, this order spent. A non-zero figure here is
  // USDC left in a shared server wallet.
  expect(realised.residual).toBe(0n);
  expect(realised.netSpent).toBe(ORDER.amountInUsdc);
  // 250 USDC over 0.78071325 shares, at the asset's real 8 decimals. Read at 18 the same two
  // integers price this fill at 3,202,200,039.51 a share.
  expect(realised.price).toBe("320.220003951514848761");

  // The custodial window is closed: the shares went straight to the user's account.
  const state = custody(chain.journal.rows, ORDER.amountInUsdc);
  expect(state.holder).toBe("account");
  expect(state.exposure).toBe(0n);
  expect(custodial(state)).toBe(false);
  expect(describeRealised(realised, buy.assetDecimals)).toContain("0.78071325 shares");
});

test("the cost of an order includes the L1 data fee, which no gas total contains", async () => {
  const chain = freshChain();
  const legs = await runLegs(chain, [
    { leg: "fund", as: "fund-confirmed" },
    { leg: "approve", as: "approve-confirmed" },
    { leg: "swap", as: "swap-confirmed" },
  ]);
  const realised = realise({ ...buy, legs });

  // What a naive cost function computes: L2 execution only.
  const l2Only = legs.reduce(
    (total, entry) => total + entry.receipt.gasUsed * entry.receipt.effectiveGasPrice,
    0n,
  );
  expect(realised.gasWei).toBe(l2Only + BigInt(legs.length) * L1_FEE_WEI);
  // Base is an OP-stack rollup: every transaction also pays to post its calldata to Ethereum,
  // and that fee is not inside `gasUsed` at all. At an ordinary Base fee it is the larger half
  // of the bill — the L2 half of these three transactions is under 40% of what they actually
  // cost, so an expense figure built from gas alone reports well under half the truth.
  expect(l2Only * 100n < realised.gasWei * 40n).toBe(true);
  expect(realised.gasWei - l2Only).toBe(3n * L1_FEE_WEI);
  for (const entry of legs)
    expect(realised.gasByLeg[entry.leg]).toBe(transactionCost(entry.receipt));
  // Gas is the operator's cost, never the user's: it is paid in ETH by the spender key and is
  // not charged back, so it stays out of what the user is out of pocket.
  expect(realised.netSpent).toBe(ORDER.amountInUsdc);
  expect(realised.gasWei).toBeGreaterThan(0n);
  expect(EFFECTIVE_GAS_PRICE_WEI).toBeGreaterThan(0n);
});

test("a fill that missed the signed floor is reported as the chain filled it, not as quoted", async () => {
  const quote = await quoteOrder();
  const chain = freshChain();
  const legs = await runLegs(chain, [
    { leg: "fund", as: "fund-confirmed" },
    { leg: "approve", as: "approve-confirmed" },
    // `status: success`, and still 100 bps under the floor the swap was signed with.
    { leg: "swap", as: "swap-underfilled" },
  ]);

  const realised = realise({ ...buy, legs });
  expect(realised.filled).toBe(77_290_611n);
  // The number the quote promised is right there and is not what gets reported. Using it would
  // have overstated the position by 0.00780714 shares and understated the price paid.
  expect(realised.filled).not.toBe(BigInt(quote.amount_out));
  expect(BigInt(quote.amount_out) - realised.filled).toBe(780_714n);

  const quality = executionQuality({
    realised,
    quotedOut: BigInt(quote.amount_out),
    minOut: BigInt(quote.min_out),
    referencePrice: quote.reference,
  });
  expect(quality.actualOut).toBe(77_290_611n);
  // The fixture is 100 bps under the signed FLOOR, which is a hair over 100 bps under the
  // quote — and the rounding is away from zero, so 100.01 bps of cost is reported as 101 and
  // never as 100. A systematic leak cannot hide as a row of noughts.
  expect(quality.slippageBps).toBe(101);
  // Below the signed floor is a distinct flag rather than a large negative cushion: the router
  // enforces `amountOutMinimum`, so a swap that breaches it should have reverted. Reaching this
  // means the floor was not the one that was signed, or the output was measured against the
  // wrong recipient — both worse than bad execution.
  expect(quality.belowFloor).toBe(true);
  expect(quality.cushionBps).toBeLessThan(0);
  // No deviation from the reference, and null rather than zero. This recorded receipt carries
  // only the delivery leg, so there is no USDC leaving the spender to price the fill against
  // and `realise` reports no price at all — an unpriceable fill is a missing observation, and
  // reporting 0 bps would state that it matched a price nobody computed.
  expect(realised.price).toBeNull();
  expect(quality.deviationFromReferenceBps).toBeNull();
  // The reference the route was admitted against is the measured AAPL NAV, not the pool's own
  // price. Deviation is only meaningful against a source the venue cannot move.
  expect(quote.reference).toBe("320.08");
});

test("a leg confirms on its transfer logs, and a shortfall is ambiguous rather than settled", async () => {
  const chain = freshChain();
  await runLegs(chain, [
    { leg: "fund", as: "fund-confirmed" },
    { leg: "approve", as: "approve-confirmed" },
    { leg: "swap", as: "swap-underfilled" },
  ]);
  chain.node.advance(CONFIRMATIONS);

  const rows = chain.journal.rows;
  const [fund, approve, swap] = rows;
  if (!fund || !approve || !swap) throw new Error("three legs must be journaled");
  const { matches, unmatched } = matchSubmissions({
    entries: rows,
    receipts: chain.node.receipts(),
    head: chain.node.head,
    confirmations: CONFIRMATIONS,
    canonicalBlockHashes: chain.node.canonicalBlockHashes(),
    evidence: new Map([
      [fund.id, FUND_EVIDENCE],
      // An allowance change moves no tokens, so an approval carries no transfer evidence and
      // must still settle on status alone.
      [approve.id, null],
      [swap.id, SWAP_EVIDENCE],
    ]),
    // A swap's output has no upper bound — it is whatever the pool paid — so equality would
    // report every favourable fill as ambiguous.
    exact: new Map([[swap.id, false]]),
  });

  expect(unmatched).toEqual([]);
  expect(matches.map((match) => match.verdict.outcome)).toEqual([
    "confirmed",
    "confirmed",
    "ambiguous",
  ]);
  expect(matches[2]?.verdict.detail).toContain(`${ORDER.minOutShares}`);
  // The journal says this leg confirmed; the receipt no longer classifies that way. That is a
  // receipt the system already acted on changing underneath it, and nothing automatic recovers.
  expect(matches[2]?.changed).toBe(true);
});

test("confirmations are counted from the node's head, so a fresh receipt is not yet settled", async () => {
  const chain = freshChain();
  const worker = boot(chain.node, chain.journal);
  const prepared = await worker.prepare(request("fund"));
  if (prepared.status !== "prepared") throw new Error("the fund leg must prepare");
  await worker.dispatch(prepared.entry, CALLS.fund);
  chain.node.mine({ as: "fund-confirmed" });

  const facts = {
    entries: chain.journal.rows,
    receipts: chain.node.receipts(),
    confirmations: CONFIRMATIONS,
    evidence: new Map([[chain.journal.rows[0]?.id ?? "", FUND_EVIDENCE]]),
  };
  const fresh = matchSubmissions({ ...facts, head: chain.node.head }).matches[0];
  // Mined in the head block is one confirmation, not zero, and one is below the bar: the
  // transaction is settled-looking and still reorg-able.
  expect(fresh?.verdict.outcome).toBe("pending");
  expect(fresh?.verdict.depth).toBe(1);

  chain.node.advance(CONFIRMATIONS - 1);
  const buried = matchSubmissions({ ...facts, head: chain.node.head }).matches[0];
  expect(buried?.verdict.outcome).toBe("confirmed");
  expect(buried?.verdict.depth).toBe(CONFIRMATIONS);
});

test("a funded order whose swap reverted is stranded, and has no realised price to report", async () => {
  const quote = await quoteOrder();
  const chain = freshChain();
  const legs = await runLegs(chain, [
    { leg: "fund", as: "fund-confirmed" },
    { leg: "approve", as: "approve-confirmed" },
    { leg: "swap", as: "swap-reverted" },
  ]);

  const realised = realise({ ...buy, legs });
  expect(realised.status).toBe("stranded");
  expect(realised.filled).toBe(0n);
  // A quote existed and promised 0.78071325 shares. Nothing was bought, so nothing is reported:
  // a realised price is a fact about a fill, and there was no fill.
  expect(realised.price).toBeNull();
  expect(BigInt(quote.amount_out)).toBeGreaterThan(0n);
  // The user's USDC is in the spender wallet, and that is what `residual` is for.
  expect(realised.residual).toBe(ORDER.amountInUsdc);
  expect(realised.netSpent).toBe(ORDER.amountInUsdc);
  // The reverted leg still cost gas, and excluding it would produce an expense figure that is
  // wrong exactly in the periods when it matters.
  expect(realised.gasByLeg.swap).toBe(transactionCost(legs[2]?.receipt as SettledLeg["receipt"]));
  expect(realised.gasWei).toBeGreaterThan(realised.gasByLeg.swap ?? 0n);

  // Custody, read from the journal rather than from the order's status summary: this service is
  // holding the input, and says so in a sentence with no addresses in it.
  const state = custody(chain.journal.rows, ORDER.amountInUsdc);
  expect(state.holder).toBe("spender");
  expect(state.exposure).toBe(ORDER.amountInUsdc);
  expect(custodial(state)).toBe(true);
  expect(state.plain).toContain("holding the input");
  expect(describeRealised(realised, buy.assetDecimals)).toContain(
    "neither been swapped nor returned",
  );
});

test("a refunded order charges the user nothing and the operator four legs of gas", async () => {
  const chain = freshChain();
  const legs = await runLegs(chain, [
    { leg: "fund", as: "fund-confirmed" },
    { leg: "approve", as: "approve-confirmed" },
    { leg: "swap", as: "swap-reverted" },
    // An allowance reset is the same kind of transaction as the approval — a write that moves
    // no tokens — so it settles on the same evidence-free receipt.
    { leg: "reset", as: "approve-confirmed" },
    { leg: "refund", as: "refund-confirmed" },
  ]);

  const realised = realise({ ...buy, legs });
  expect(realised.status).toBe("refunded");
  expect(realised.returned).toBe(ORDER.amountInUsdc);
  // Out and back: the user paid nothing, and the operator paid for five transactions to
  // discover that.
  expect(realised.netSpent).toBe(0n);
  expect(realised.residual).toBe(0n);
  expect(realised.gasWei).toBe(
    legs.reduce((total, entry) => total + transactionCost(entry.receipt), 0n),
  );
  expect(describeRealised(realised, buy.assetDecimals)).toContain(
    "nothing is charged to the account",
  );

  const state = custody(chain.journal.rows, ORDER.amountInUsdc);
  expect(state.holder).toBe("account");
  expect(state.exposure).toBe(0n);
  expect(custodial(state)).toBe(false);
});

test("a funding leg still in flight is accounted as this service's exposure, not the user's", async () => {
  const chain = freshChain();
  const worker = boot(chain.node, chain.journal);
  const prepared = await worker.prepare(request("fund"));
  if (prepared.status !== "prepared") throw new Error("the fund leg must prepare");
  await worker.dispatch(prepared.entry, CALLS.fund);

  // Broadcast, no receipt. It may already have mined; reporting "the user still holds it"
  // because we have not looked yet is the one answer that is never safe.
  const state = custody(chain.journal.rows, ORDER.amountInUsdc);
  expect(state.holder).toBe("unknown");
  expect(state.exposure).toBe(ORDER.amountInUsdc);
  expect(state.settled).toBe(false);
  expect(custodial(state)).toBe(true);
});
