import type { ExecutionRow, TransactionRow } from "@mandate/database";
import type { Envelope, Intent } from "@mandate/strategy";
import { base } from "viem/chains";
import {
  addGas,
  type FillPricing,
  fillPricing,
  type GasCost,
  type Side,
  type TokenAmount,
  tokenAmount,
  tokenMeta,
} from "./pricing.js";
import type { Settlement } from "./receipts.js";

/** Basescan. Taken from viem's chain definition so the host cannot drift from the RPC's. */
const EXPLORER = base.blockExplorers.default.url;
export const explorerLink = (hash: string | null | undefined) =>
  hash ? `${EXPLORER}/tx/${hash}` : null;

/** Every value `executions.status` may hold, per the CHECK added in 0004_worker_journal. */
export const EXECUTION_STATUSES = [
  "signal",
  "admitted",
  "pending",
  "confirmed",
  "reverted",
  "cancelled",
  "refunded",
  "recovery_required",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/**
 * What the user is told happened, as distinct from the worker's internal status.
 *
 * `signal` is its own outcome and not a failure: in manual mode the strategy fired and the
 * system deliberately did not trade on the user's behalf. `cancelled` is also not a loss — it
 * specifically means no funds ever left the account, because the lifecycle only cancels before
 * the funding leg exists.
 */
export const OUTCOMES = {
  signal: {
    outcome: "signal",
    headline: "Signalled, not traded",
    detail:
      "Your strategy's conditions were met. This strategy runs in manual mode, so nothing was traded for you.",
  },
  admitted: {
    outcome: "queued",
    headline: "Queued",
    detail:
      "The order passed its limits and is waiting for the executor to sign the first transaction.",
  },
  pending: {
    outcome: "in_flight",
    headline: "In flight",
    detail: "A transaction has been signed and is being settled onchain.",
  },
  confirmed: {
    outcome: "filled",
    headline: "Filled",
    detail: "The swap settled onchain and the asset was delivered to your account.",
  },
  reverted: {
    outcome: "reverted",
    headline: "Did not go through",
    detail: "A transaction reverted onchain. No asset was delivered.",
  },
  cancelled: {
    outcome: "cancelled",
    headline: "Stopped before funding",
    detail: "The order was dropped before any money left your account.",
  },
  refunded: {
    outcome: "refunded",
    headline: "Returned to you",
    detail: "The order could not complete, so the input was sent back to your account.",
  },
  recovery_required: {
    outcome: "needs_review",
    headline: "Needs review",
    detail:
      "The onchain evidence for this order is inconsistent. The strategy has been halted and an operator must inspect the transaction journal.",
  },
} as const satisfies Record<ExecutionStatus, { outcome: string; headline: string; detail: string }>;

export type Outcome = (typeof OUTCOMES)[ExecutionStatus]["outcome"];

export function outcomeOf(status: string) {
  return (
    OUTCOMES[status as ExecutionStatus] ?? {
      outcome: "unknown" as const,
      headline: "Unrecognised state",
      detail: "This order is in a state this version of the API does not describe.",
    }
  );
}

/**
 * The exact strings @mandate/execution's Lifecycle writes into `executions.reason`, translated.
 *
 * Re-declared here rather than imported: @mandate/execution is a worker dependency and must
 * not become an API dependency to render a sentence. The raw string is always returned
 * alongside the translation, so a worker that adds a reason this table has not learned yet
 * still shows the user something true instead of nothing.
 */
export const EXECUTION_REASONS: Record<string, { code: string; message: string }> = {
  "Funding reverted": {
    code: "funding-reverted",
    message: "Pulling the input from your spend permission reverted onchain. Nothing was spent.",
  },
  "Previously settled receipt changed": {
    code: "receipt-changed",
    message:
      "A transaction that had already settled no longer matches the chain. Execution stopped pending review.",
  },
  "Unresolved transaction evidence; inspect journal before recovery": {
    code: "evidence-unresolved",
    message:
      "A submitted transaction could not be resolved to a receipt within the timeout. Execution stopped pending review.",
  },
  "Input returned to strategy account": {
    code: "input-returned",
    message: "The input was transferred back to your account.",
  },
  "Refund or allowance reset reverted": {
    code: "unwind-reverted",
    message: "Returning the input reverted onchain. Execution stopped pending review.",
  },
  "Strategy no longer armed": {
    code: "not-armed",
    message:
      "The strategy was paused, halted or expired before the order was funded, so it was dropped.",
  },
  "Cannot establish safe execution or refund": {
    code: "unsafe-execution",
    message:
      "Neither a safe swap nor a safe refund could be prepared. Execution stopped pending review.",
  },
  "Admission checks failed before funding": {
    code: "preconditions-failed",
    message:
      "A precondition stopped holding before funding — the permission, the market session, the route or the strategy condition. Nothing was spent.",
  },
  "Execution unavailable; returning funded input": {
    code: "returning-input",
    message: "The swap could not be prepared after funding, so the input is being returned to you.",
  },
};

export type Reason = { code: string; message: string; raw: string };

export function reasonOf(reason: string | null): Reason | null {
  if (!reason) return null;
  const known = EXECUTION_REASONS[reason];
  // An unknown reason is still ours — it comes from our worker, never from an upstream error
  // object — so showing it verbatim leaks nothing and is better than "something went wrong".
  return { code: known?.code ?? "other", message: known?.message ?? reason, raw: reason };
}

/**
 * `evaluations.outcome` and the refusal strings @mandate/strategy's `tick()` produces.
 *
 * The refusals are the whole point of the refusal ledger: a user needs to see that the system
 * considered acting and chose not to. Every one of these is a deliberate decision, not a fault.
 */
export const EVALUATION_REASONS: Record<string, { code: string; message: string }> = {
  evaluated: { code: "evaluated", message: "Conditions checked; no rule fired." },
  halted: { code: "halted", message: "The strategy halted itself." },
  expired: { code: "expired", message: "The strategy's expiry passed." },
  "execution-disabled": {
    code: "execution-disabled",
    message: "Automatic execution is switched off on the executor.",
  },
  "eligibility-renewal-required": {
    code: "eligibility-renewal-required",
    message: "Your jurisdiction check needs renewing before this strategy can trade again.",
  },
  "observation-or-authority-unavailable": {
    code: "observation-unavailable",
    message:
      "Prices, the spend permission or the venue could not be verified, so the tick was skipped.",
  },
  "observation-expired": {
    code: "observation-expired",
    message:
      "The market observation was older than 30 seconds by the time the tick committed, so it was discarded.",
  },
  "Strategy expired": { code: "expired", message: "The strategy's expiry passed." },
  "Order resolves to zero": {
    code: "zero-size",
    message: "The rule's size worked out to zero at current prices.",
  },
  "Order count limit reached": {
    code: "order-count-cap",
    message: "The order limit for the current period was already used up.",
  },
  "Cooldown active": {
    code: "cooldown",
    message: "The cooldown you set for this rule had not elapsed.",
  },
  "Per-order cap exceeded": {
    code: "per-order-cap",
    message: "The order was larger than your per-order cap.",
  },
  "Period cap exceeded": {
    code: "period-cap",
    message: "The order would have taken the period's spend past your cap.",
  },
  "Lifetime cap exceeded": {
    code: "lifetime-cap",
    message: "The order would have taken lifetime spend past your cap.",
  },
  "Insufficient stock balance": {
    code: "insufficient-balance",
    message: "Your account did not hold enough of the asset to sell.",
  },
};

export function evaluationReason(value: string): Reason {
  const known = EVALUATION_REASONS[value];
  return { code: known?.code ?? "other", message: known?.message ?? value, raw: value };
}

/** `tick()` joins its refusals with "; " into one column. Split them back apart to count them. */
export function splitRefusals(refused: string | null): string[] {
  return refused
    ? refused
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
    : [];
}

export type JournalEntry = {
  leg: TransactionRow["leg"];
  status: TransactionRow["status"];
  hash: string;
  explorer_url: string | null;
  signer: string;
  nonce: number;
  submitted_at: string;
  confirmed_at: string | null;
  /**
   * What the worker committed to before signing, in human units. For the swap leg this is
   * `amountOutMinimum` — the slippage floor — which is why it is called a guaranteed minimum
   * and never "received". Presenting the floor as the fill would claim zero slippage on every
   * single trade.
   */
  expectation: {
    kind: "guaranteed_minimum" | "transfer";
    amount: TokenAmount;
    recipient: string;
    from: string | null;
  } | null;
  settlement: Settlement | null;
};

/**
 * Projects one journal row for the response.
 *
 * An explicit allowlist, not a spread with deletions. `transactions` carries `rawTransaction` —
 * a signed, possibly not-yet-broadcast transaction, already in pino's redact list — and
 * `userId`. A future column added to the table must not appear in an HTTP response because
 * someone forgot to extend a blocklist.
 */
export function journalEntry(
  row: TransactionRow,
  envelope: Envelope | undefined,
  settlement: Settlement | null,
): JournalEntry {
  const evidence = row.evidence;
  return {
    leg: row.leg,
    status: row.status,
    hash: row.hash,
    explorer_url: explorerLink(row.hash),
    signer: row.signer,
    nonce: row.nonce,
    submitted_at: row.createdAt.toISOString(),
    confirmed_at: row.confirmedAt?.toISOString() ?? null,
    expectation: evidence
      ? {
          kind: row.leg === "swap" ? "guaranteed_minimum" : "transfer",
          amount: tokenAmount(envelope, evidence.token, evidence.amount),
          recipient: evidence.recipient,
          from: evidence.from ?? null,
        }
      : null,
    settlement,
  };
}

export type ExecutionListItem = {
  id: string;
  instance: string;
  strategy_name: string | null;
  status: ExecutionStatus | string;
  stage: string;
  outcome: string;
  headline: string;
  what_happened: string;
  side: Side;
  symbol: string | null;
  spent: TokenAmount;
  intended_amount: string | null;
  tx_hash: string | null;
  explorer_url: string | null;
  reason: Reason | null;
  created_at: string;
  updated_at: string;
  /**
   * Compatibility block. apps/web's `Execution` type reads these camelCase keys off the raw
   * row that GET /v1/instances/:id/executions returns today. They are the same values as the
   * snake_case fields above, so the enriched shape is a superset and the web app keeps working
   * across the swap. Delete them once apps/web reads the fields above.
   */
  instanceId: string;
  amountIn: string;
  tokenIn: string;
  tokenOut: string;
  txHash: string | null;
  createdAt: string;
  intent: Intent | null;
};

/** Which side this order is, preferring the signed intent and falling back to the token pair. */
export function sideOf(row: ExecutionRow, envelope: Envelope | undefined): Side {
  if (row.intent?.side === "buy" || row.intent?.side === "sell") return row.intent.side;
  const quote = envelope?.quote.toLowerCase();
  return quote && row.tokenIn.toLowerCase() === quote ? "buy" : "sell";
}

/**
 * The traded asset.
 *
 * `intent.asset` indexes `envelope.assets`, so it is used first — but it is cross-checked
 * against the addresses actually written on the row, and the row wins on disagreement. The
 * row's `token_in`/`token_out` are what the transaction was built from; the index is a
 * reference into a list that a future envelope migration could reorder.
 */
export function assetTokenOf(row: ExecutionRow, side: Side) {
  return side === "buy" ? row.tokenOut : row.tokenIn;
}

export function executionListItem(
  row: ExecutionRow,
  envelope: Envelope | undefined,
  strategyName: string | null,
): ExecutionListItem {
  const side = sideOf(row, envelope);
  const spent = tokenAmount(envelope, row.tokenIn, row.amountIn);
  const outcome = outcomeOf(row.status);
  const { symbol } = tokenMeta(envelope, assetTokenOf(row, side));
  return {
    id: row.id,
    instance: row.instanceId,
    strategy_name: strategyName,
    status: row.status,
    stage: row.stage,
    outcome: outcome.outcome,
    headline: outcome.headline,
    what_happened: outcome.detail,
    side,
    symbol,
    spent,
    intended_amount: row.intent?.amount ?? null,
    tx_hash: row.txHash,
    explorer_url: explorerLink(row.txHash),
    reason: reasonOf(row.reason),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    instanceId: row.instanceId,
    amountIn: row.amountIn,
    tokenIn: row.tokenIn,
    tokenOut: row.tokenOut,
    txHash: row.txHash,
    createdAt: row.createdAt.toISOString(),
    intent: row.intent,
  };
}

export type DecisionView = {
  at: string;
  outcome: Reason;
  admitted: number;
  /** The exact feed values the rules were evaluated against on this tick. */
  inputs: Record<string, string>;
  refusals: Reason[];
  notifications: string[];
};

export type FillState = "verified" | "unverified" | "not_applicable";

export type ExecutionDetail = ExecutionListItem & {
  account: string;
  fill: {
    state: FillState;
    /** Why the fill is unverified, when it is. */
    reason: string;
    guaranteed_minimum: TokenAmount | null;
    received: TokenAmount | null;
    price: FillPricing;
  };
  cost: {
    /** What actually left the user's account. Gas is not part of it — see `gas.borne_by`. */
    input: TokenAmount;
    gas: {
      complete: boolean;
      legs: number;
      paid_by: string | null;
      borne_by: "executor";
      note: string;
    } & GasCost;
  } | null;
  decision: DecisionView | null;
  journal: JournalEntry[];
};

export type DetailInput = {
  row: ExecutionRow;
  envelope: Envelope | undefined;
  strategyName: string | null;
  account: string;
  journal: readonly TransactionRow[];
  settlements: ReadonlyMap<string, Settlement | null>;
  evaluation:
    | {
        at: Date;
        outcome: string;
        admitted: number;
        refused: string | null;
        inputs: Record<string, string>;
        notifications: string[];
      }
    | undefined;
  /** True when a receipt reader is wired at all. Distinguishes "not asked" from "asked, failed". */
  receiptsEnabled: boolean;
};

const GAS_NOTE =
  "Gas is paid in ETH by the executor's wallet, not from your spend permission, which moves exactly the input amount. It is shown so you can see the real cost of running the order; it is not deducted from your funds.";

export function executionDetail(input: DetailInput): ExecutionDetail {
  const { row, envelope, journal, settlements } = input;
  const side = sideOf(row, envelope);
  const swap = journal.find((t) => t.leg === "swap");
  const swapSettlement = swap ? (settlements.get(swap.hash) ?? null) : null;
  const guaranteed =
    swap?.evidence && swap.leg === "swap"
      ? tokenAmount(envelope, swap.evidence.token, swap.evidence.amount)
      : null;
  const receivedRaw = swapSettlement?.status === "confirmed" ? swapSettlement.received : null;
  const received =
    receivedRaw !== null && swap?.evidence
      ? tokenAmount(envelope, swap.evidence.token, receivedRaw)
      : null;

  // "verified" is claimed only when a receipt was actually decoded. Everything else says so and
  // says why, because a number invented here would be indistinguishable from a real fill.
  const state: FillState = received ? "verified" : !swap ? "not_applicable" : "unverified";
  const fillReason = received
    ? "Amount confirmed from the swap transaction's Transfer logs."
    : !swap
      ? row.status === "signal"
        ? "This strategy runs in manual mode; no swap was submitted."
        : "No swap transaction was submitted for this order."
      : swap.status === "signed"
        ? "The swap transaction has not settled yet."
        : swapSettlement?.status === "reverted"
          ? "The swap transaction reverted, so nothing was received."
          : input.receiptsEnabled
            ? "The swap receipt could not be read from the chain right now. The record below is what was signed, not what was filled."
            : "No chain reader is configured, so the filled amount cannot be verified. The record below is what was signed, not what was filled.";

  let gas: GasCost | null = null;
  let legs = 0;
  let complete = true;
  for (const entry of journal) {
    if (entry.status === "signed") continue; // Not settled: no receipt, no fee to report.
    const settlement = settlements.get(entry.hash) ?? null;
    if (!settlement) {
      complete = false;
      continue;
    }
    gas = gas ? addGas(gas, settlement.gas) : settlement.gas;
    legs++;
  }

  const spent = tokenAmount(envelope, row.tokenIn, row.amountIn);
  return {
    ...executionListItem(row, envelope, input.strategyName),
    account: input.account,
    fill: {
      state,
      reason: fillReason,
      guaranteed_minimum: guaranteed,
      received,
      price: fillPricing(side, spent, guaranteed, received),
    },
    cost: gas
      ? {
          input: spent,
          gas: {
            ...gas,
            complete,
            legs,
            paid_by: journal.find((t) => t.status !== "signed")?.signer ?? null,
            borne_by: "executor",
            note: GAS_NOTE,
          },
        }
      : null,
    decision: input.evaluation
      ? {
          at: input.evaluation.at.toISOString(),
          outcome: evaluationReason(input.evaluation.outcome),
          admitted: input.evaluation.admitted,
          inputs: input.evaluation.inputs,
          refusals: splitRefusals(input.evaluation.refused).map(evaluationReason),
          notifications: input.evaluation.notifications,
        }
      : null,
    journal: journal.map((entry) =>
      journalEntry(entry, envelope, settlements.get(entry.hash) ?? null),
    ),
  };
}
