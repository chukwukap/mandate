/**
 * Matching submissions to receipts, and deriving the result from the receipts.
 *
 * `logs.ts` reads what moved, `receipts.ts` decides whether the chain has actually said so
 * yet, and `outcome.ts` turns settled legs into the numbers a user and an operator see.
 * Nothing in this directory reads a quote, an intent amount, or a transaction's calldata to
 * decide what happened — those describe what was asked for, and the whole purpose of
 * reconciliation is to find out what was done.
 */

export type { LogRecord, TransferEvent, TransferFilter } from "./logs.js";
export {
  asAddress,
  netTransferred,
  received,
  sent,
  TRANSFER_TOPIC,
  totalTransferred,
  transfers,
} from "./logs.js";
export type {
  ExecutionQuality,
  RealisedOrder,
  RealisedStatus,
  RealiseInput,
  SettledLeg,
  Valuation,
} from "./outcome.js";
export {
  describeRealised,
  executionQuality,
  markToMarket,
  realise,
  realisedPrice,
} from "./outcome.js";
export type {
  Confirmation,
  MatchResult,
  ReceiptFacts,
  ReceiptRecord,
  ReceiptVerdict,
  SubmissionMatch,
  TransferEvidence,
} from "./receipts.js";
export { classifyReceipt, matchSubmissions, transactionCost } from "./receipts.js";
