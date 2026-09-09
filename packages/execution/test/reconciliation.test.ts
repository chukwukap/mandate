import { expect, test } from "bun:test";
import {
  classifyReceipt,
  describeRealised,
  executionQuality,
  type LogRecord,
  markToMarket,
  matchSubmissions,
  type ReceiptRecord,
  realise,
  realisedPrice,
  received,
  type SettledLeg,
  TRANSFER_TOPIC,
  totalTransferred,
  transactionCost,
  transfers,
} from "../src/reconciliation/index.js";
import type { JournalEntry } from "../src/submission/index.js";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// AAPLc. Eight decimals, not eighteen — the single most expensive assumption in this system.
const AAPLC = "0xb200000000000000000000c2e324d24d7eecd1fb";
const AAPLC_DECIMALS = 8;
// The user's own embedded wallet: it signs both legs, pays the input and receives the output.
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const POOL = "0x3333333333333333333333333333333333333333";
// A third party that appears in the same receipts, so a filter by address has something to miss.
const OTHER = "0x2222222222222222222222222222222222222222";

/**
 * Transcribed independently of `src/reconciliation/logs.ts`: this is
 * `keccak256("Transfer(address,address,uint256)")` as published in the ERC-20 specification
 * and as it appears on every Base token transfer. A typo in the source constant makes every
 * receipt decode to zero transfers, which reads as "nothing moved" — so it is pinned here.
 */
const SPEC_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const topic = (address: string) =>
  `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

function transferLog(token: string, from: string, to: string, value: bigint): LogRecord {
  return {
    address: token,
    topics: [SPEC_TRANSFER_TOPIC, topic(from), topic(to)],
    data: word(value),
  };
}

function receipt(over: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    transactionHash: over.transactionHash ?? `0x${"aa".repeat(32)}`,
    blockNumber: over.blockNumber ?? 100n,
    blockHash: over.blockHash ?? `0x${"bb".repeat(32)}`,
    status: over.status ?? "success",
    gasUsed: over.gasUsed ?? 120_000n,
    effectiveGasPrice: over.effectiveGasPrice ?? 50_000_000n,
    // "l1Fee" in over, not ??: a client that does not surface the fee reports null, and
    // that case has to be constructible.
    l1Fee: "l1Fee" in over ? over.l1Fee : 1_000_000_000_000n,
    logs: over.logs ?? [],
  };
}

test("the source transfer topic matches the specification", () => {
  expect(TRANSFER_TOPIC).toBe(SPEC_TRANSFER_TOPIC);
});

test("standard transfers decode and non-standard logs are skipped, never thrown on", () => {
  const logs: LogRecord[] = [
    transferLog(USDC, ACCOUNT, POOL, 100_000000n),
    // A receipt carries every contract the transaction touched. None of these three may
    // stop the decode, and none of them may be counted.
    { address: USDC, topics: [SPEC_TRANSFER_TOPIC, topic(ACCOUNT)], data: word(5n) },
    {
      address: USDC,
      topics: [`0x${"cc".repeat(32)}`, topic(ACCOUNT), topic(POOL)],
      data: word(5n),
    },
    { address: USDC, topics: [SPEC_TRANSFER_TOPIC, topic(ACCOUNT), topic(POOL)], data: "0x" },
  ];
  const decoded = transfers(logs);
  expect(decoded).toHaveLength(1);
  expect(decoded[0]).toEqual({
    token: USDC,
    from: ACCOUNT,
    to: POOL,
    value: 100_000000n,
  });
});

test("repeated transfers to the same address are summed, not sampled", () => {
  // A router that sweeps a remainder emits a second transfer. Taking the first would
  // under-count the fill and overstate the price paid.
  const logs = [
    transferLog(AAPLC, POOL, ACCOUNT, 31_000_000n),
    transferLog(AAPLC, POOL, ACCOUNT, 228_530n),
    transferLog(AAPLC, POOL, OTHER, 999n),
  ];
  expect(received(logs, AAPLC, ACCOUNT)).toBe(31_228_530n);
  expect(totalTransferred(logs, { token: AAPLC, to: ACCOUNT, from: POOL })).toBe(31_228_530n);
  expect(received(logs, USDC, ACCOUNT)).toBe(0n);
});

test("a transaction costs its L1 data fee too, and costs it even when it reverts", () => {
  // gasUsed * effectiveGasPrice alone understates every Base transaction, and excluding
  // failures produces an expense figure that is wrong exactly when it matters.
  expect(transactionCost(receipt())).toBe(120_000n * 50_000_000n + 1_000_000_000_000n);
  expect(transactionCost(receipt({ status: "reverted" }))).toBe(
    120_000n * 50_000_000n + 1_000_000_000_000n,
  );
  expect(transactionCost(receipt({ l1Fee: null }))).toBe(120_000n * 50_000_000n);
});

const base = { hash: `0x${"aa".repeat(32)}`, head: 110n, confirmations: 3 };

test("a missing receipt is pending until the nonce says otherwise", () => {
  expect(classifyReceipt({ ...base, receipt: null }).outcome).toBe("pending");
  const displaced = classifyReceipt({
    ...base,
    receipt: null,
    nonce: 7,
    signerLatestNonce: 8,
  });
  expect(displaced.outcome).toBe("ambiguous");
  expect(displaced.detail).toContain("consumed");
});

test("confirmations are counted inclusively and a shallow receipt stays pending", () => {
  expect(classifyReceipt({ ...base, receipt: receipt({ blockNumber: 110n }) }).outcome).toBe(
    "pending",
  );
  expect(classifyReceipt({ ...base, receipt: receipt({ blockNumber: 108n }) })).toEqual({
    outcome: "confirmed",
    depth: 3,
    detail: "Confirmed.",
  });
});

test("a receipt in a block that is no longer canonical is ambiguous, not confirmed", () => {
  const verdict = classifyReceipt({
    ...base,
    receipt: receipt(),
    canonicalBlockHash: `0x${"cd".repeat(32)}`,
  });
  expect(verdict.outcome).toBe("ambiguous");
});

test("a receipt for different bytes is never accepted as this transaction's", () => {
  const verdict = classifyReceipt({
    ...base,
    receipt: receipt({ transactionHash: `0x${"ff".repeat(32)}` }),
  });
  expect(verdict.outcome).toBe("ambiguous");
});

test("success is not evidence; the transfer logs are", () => {
  // The swap's input is an amount this system chose, so it is matched exactly.
  const evidence = { token: USDC, recipient: POOL, amount: "100000000", from: ACCOUNT };
  const short = classifyReceipt({
    ...base,
    receipt: receipt({ logs: [transferLog(USDC, ACCOUNT, POOL, 99_000000n)] }),
    evidence,
  });
  expect(short.outcome).toBe("ambiguous");

  const exact = classifyReceipt({
    ...base,
    receipt: receipt({ logs: [transferLog(USDC, ACCOUNT, POOL, 100_000000n)] }),
    evidence,
  });
  expect(exact.outcome).toBe("confirmed");

  // A swap that took MORE of the user's USDC than it was signed for is not a happy surprise.
  const over = classifyReceipt({
    ...base,
    receipt: receipt({ logs: [transferLog(USDC, ACCOUNT, POOL, 101_000000n)] }),
    evidence,
  });
  expect(over.outcome).toBe("ambiguous");

  // A swap's output has no upper bound: a favourable fill must not read as ambiguous.
  const favourable = classifyReceipt({
    ...base,
    receipt: receipt({ logs: [transferLog(AAPLC, POOL, ACCOUNT, 40_000_000n)] }),
    evidence: { token: AAPLC, recipient: ACCOUNT, amount: "31093750" },
    exact: false,
  });
  expect(favourable.outcome).toBe("confirmed");
});

test("a reverted receipt is reverted even when the evidence would have matched", () => {
  const verdict = classifyReceipt({
    ...base,
    receipt: receipt({
      status: "reverted",
      logs: [transferLog(USDC, ACCOUNT, POOL, 100_000000n)],
    }),
    evidence: { token: USDC, recipient: POOL, amount: "100000000" },
  });
  expect(verdict.outcome).toBe("reverted");
});

function journalRow(over: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: over.id ?? "t1",
    executionId: "order-a",
    leg: over.leg ?? "approve",
    signer: ACCOUNT,
    nonce: over.nonce ?? 7,
    hash: over.hash ?? `0x${"aa".repeat(32)}`,
    rawTransaction: "0x02f8aa",
    status: over.status ?? "signed",
    ...over,
  };
}

test("submissions are matched by hash, and a settled leg that changed is flagged", () => {
  const settled = journalRow({ id: "t1", status: "confirmed", hash: `0x${"aa".repeat(32)}` });
  const inFlight = journalRow({ id: "t2", leg: "swap", nonce: 8, hash: `0x${"bb".repeat(32)}` });
  const result = matchSubmissions({
    entries: [settled, inFlight],
    receipts: [
      receipt({ transactionHash: `0x${"aa".repeat(32)}`, blockNumber: 100n, status: "reverted" }),
      receipt({ transactionHash: `0x${"ee".repeat(32)}`, blockNumber: 101n }),
    ],
    head: 110n,
    confirmations: 3,
  });
  const [first, second] = result.matches;
  // A leg recorded as confirmed that now reverts is a receipt that changed underneath us.
  expect(first?.verdict.outcome).toBe("reverted");
  expect(first?.changed).toBe(true);
  expect(second?.receipt).toBeNull();
  expect(second?.verdict.outcome).toBe("pending");
  expect(second?.changed).toBe(false);
  // Bytes sent from the user's wallet that no journal row claims.
  expect(result.unmatched).toHaveLength(1);
});

/**
 * 100 USDC in, 0.31228530 AAPLc out, with a reverted approval retried on the way.
 *
 * Both legs are signed by the user's wallet, so the swap receipt is the whole story: the USDC
 * leaves the account and the shares arrive in the same transaction. The reverted approval is
 * kept because it cost gas, and gas is part of what the order did.
 */
function buyLegs(): SettledLeg[] {
  return [
    {
      leg: "approve",
      receipt: receipt({
        transactionHash: `0x${"a2".repeat(32)}`,
        status: "reverted",
        gasUsed: 50_000n,
        l1Fee: 800_000_000_000n,
        logs: [],
      }),
    },
    {
      leg: "swap",
      receipt: receipt({
        transactionHash: `0x${"a3".repeat(32)}`,
        gasUsed: 300_000n,
        l1Fee: 2_000_000_000_000n,
        logs: [
          transferLog(USDC, ACCOUNT, POOL, 100_000000n),
          transferLog(AAPLC, POOL, ACCOUNT, 31_228_530n),
        ],
      }),
    },
  ];
}

const buy = {
  side: "buy" as const,
  account: ACCOUNT,
  assetToken: AAPLC,
  assetDecimals: AAPLC_DECIMALS,
  quoteToken: USDC,
};

test("the realised fill and its price come from the receipts", () => {
  const result = realise({ ...buy, legs: buyLegs() });
  expect(result.status).toBe("filled");
  // What left the account IS the swap input: there is no funding hop for the two to differ.
  expect(result.accountSpent).toBe(100_000000n);
  expect(result.swapInput).toBe(100_000000n);
  expect(result.filled).toBe(31_228_530n);
  expect(result.netSpent).toBe(100_000000n);
  expect(result.price).toBe("320.220003951514848761");
  // Nothing transits a service wallet, so nothing can be credited to one, returned from one,
  // or left sitting in one. A non-zero residual on a clean fill would be reported as
  // cross-order contamination — an alarm that can no longer mean anything.
  expect(result.spenderCredited).toBe(0n);
  expect(result.returned).toBe(0n);
  expect(result.residual).toBe(0n);
  // Gas is summed over every leg INCLUDING the reverted approval, which still cost money.
  expect(result.gasWei).toBe(20_300_000_000_000n);
  expect(result.gasByLeg.approve).toBe(50_000n * 50_000_000n + 800_000_000_000n);
  expect(result.gasByLeg.swap).toBe(300_000n * 50_000_000n + 2_000_000_000_000n);
  expect(describeRealised(result, AAPLC_DECIMALS)).toContain("0.3122853 shares");
  expect(describeRealised(result, AAPLC_DECIMALS)).toContain("your wallet paid");
});

test("a sell reads the same receipt with the tokens the other way round", () => {
  const result = realise({
    ...buy,
    side: "sell",
    legs: [
      {
        leg: "swap",
        receipt: receipt({
          logs: [
            transferLog(AAPLC, ACCOUNT, POOL, 31_228_530n),
            transferLog(USDC, POOL, ACCOUNT, 100_000000n),
          ],
        }),
      },
    ],
  });
  expect(result.status).toBe("filled");
  expect(result.swapInput).toBe(31_228_530n);
  expect(result.filled).toBe(100_000000n);
  // Same fill, same price: the side changes which token is the input, not what a share cost.
  expect(result.price).toBe("320.220003951514848761");
});

test("assuming eighteen decimals misprices the same fill by ten orders of magnitude", () => {
  const right = realisedPrice({
    quoteAmount: 100_000000n,
    assetAmount: 31_228_530n,
    assetDecimals: 8,
  });
  const wrong = realisedPrice({
    quoteAmount: 100_000000n,
    assetAmount: 31_228_530n,
    assetDecimals: 18,
  });
  expect(right?.startsWith("320.22")).toBe(true);
  // Not a rounding difference: a plausible-looking number that is 1e10 too large.
  expect(wrong?.startsWith("3202200039515.14")).toBe(true);
  expect(realisedPrice({ quoteAmount: 100_000000n, assetAmount: 0n, assetDecimals: 8 })).toBeNull();
});

test("a reverted leg leaves the account untouched and still costs gas", () => {
  // Whether the approval or the swap reverts, no token moved: the router allowance is the
  // only thing an approval writes, and a reverted swap moves nothing at all. The wallet still
  // paid for the attempt, and hiding that would make a string of failed orders look free.
  for (const legs of [
    [{ leg: "approve" as const, receipt: receipt({ status: "reverted" }) }],
    [
      { leg: "approve" as const, receipt: receipt() },
      {
        leg: "swap" as const,
        receipt: receipt({ transactionHash: `0x${"c1".repeat(32)}`, status: "reverted" }),
      },
    ],
  ]) {
    const result = realise({ ...buy, legs });
    expect(result.status).toBe("not-funded");
    expect(result.accountSpent).toBe(0n);
    expect(result.filled).toBe(0n);
    expect(result.netSpent).toBe(0n);
    expect(result.price).toBeNull();
    expect(result.gasWei).toBeGreaterThan(0n);
    expect(describeRealised(result, AAPLC_DECIMALS)).toContain("No swap settled");
  }
});

test("a confirmed approval alone has settled nothing", () => {
  // An approval is not a trade. Reporting it as anything but "no fill yet" would show a
  // position that does not exist while the swap is still in flight.
  const result = realise({ ...buy, legs: [{ leg: "approve", receipt: receipt() }] });
  expect(result.status).toBe("not-funded");
  expect(result.accountSpent).toBe(0n);
  expect(result.gasByLeg.approve).toBeGreaterThan(0n);
});

test("an order with no settled leg is unsettled, not a fill of zero", () => {
  const result = realise({ ...buy, legs: [] });
  expect(result.status).toBe("unsettled");
  expect(result.gasWei).toBe(0n);
  expect(result.price).toBeNull();
  expect(describeRealised(result, AAPLC_DECIMALS)).toContain("No transaction");
});

test("execution quality measures the fill against the quote and against the reference", () => {
  const result = realise({ ...buy, legs: buyLegs() });
  const quality = executionQuality({
    realised: result,
    quotedOut: 31_250_000n,
    minOut: 31_093_750n,
    referencePrice: "320.08",
  });
  expect(quality.actualOut).toBe(31_228_530n);
  // Rounded away from zero: a sub-basis-point cost is never reported as no cost at all.
  expect(quality.slippageBps).toBe(7);
  expect(quality.cushionBps).toBe(44);
  expect(quality.belowFloor).toBe(false);
  expect(quality.deviationFromReferenceBps).toBe(5);
});

test("a fill under the signed floor is flagged rather than shown as a large negative cushion", () => {
  const result = realise({ ...buy, legs: buyLegs() });
  const quality = executionQuality({
    realised: result,
    quotedOut: 40_000_000n,
    minOut: 39_000_000n,
  });
  expect(quality.belowFloor).toBe(true);
  expect(quality.deviationFromReferenceBps).toBeNull();
});

test("a missing reference price yields no deviation rather than a deviation of zero", () => {
  const result = realise({ ...buy, legs: buyLegs() });
  expect(
    executionQuality({ realised: result, quotedOut: 1n, minOut: 1n, referencePrice: "0" })
      .deviationFromReferenceBps,
  ).toBeNull();
});

test("a mark to market is unrealised and is computed at the asset's real scale", () => {
  const result = realise({ ...buy, legs: buyLegs() });
  const mark = markToMarket({
    shares: result.filled,
    assetDecimals: AAPLC_DECIMALS,
    // The Chainlink answer, passed through unmodified: it is a TOTAL RETURN feed and the
    // split/dividend multiplier is already inside it.
    referencePrice: "320.08",
    netSpent: result.netSpent,
  });
  expect(mark?.value).toBe(99_956_278n);
  expect(mark?.unrealised).toBe(99_956_278n - 100_000000n);
  expect(
    markToMarket({ shares: 1n, assetDecimals: 8, referencePrice: "nope", netSpent: 0n }),
  ).toBeNull();
});
