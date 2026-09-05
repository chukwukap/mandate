/**
 * The transaction pipeline: build, simulate, sign, record, simulate, broadcast.
 *
 * `submitter.ts` sequences; everything else decides, and everything else is pure. That
 * split is what lets the interesting failures — a foreign transaction on the spender key, a
 * quote whose deadline expired between the signature and the send, a wallet that cannot
 * afford to refund what it just pulled — be exercised in a unit test with no node and no
 * private key anywhere in the process.
 */

export type { GasBudget, GasBudgetInput } from "./gas.js";
export {
  checkGas,
  describeGasShortfall,
  gasReserve,
  L1_FEE_ALLOWANCE_WEI,
  LEG_GAS_LIMITS,
  LEG_SEQUENCE,
  remainingLegs,
} from "./gas.js";
export type { NonceBlockCode, NonceFacts, NoncePlan } from "./nonce.js";
export { planNonce } from "./nonce.js";
export type { SimulationVerdict } from "./simulation.js";
export {
  classifySimulationFailure,
  revertData,
  revertReason,
  sanitize,
  simulate,
} from "./simulation.js";
export type { SubmissionRequest, SubmitterOptions } from "./submitter.js";
export { Submitter } from "./submitter.js";
export type {
  JournalEntry,
  RecordedSubmission,
  SignedTransaction,
  SubmissionCall,
  SubmissionChain,
  SubmissionJournal,
  SubmissionRefusal,
  SubmissionRefusalCode,
  SubmissionResult,
} from "./types.js";
export { retryable } from "./types.js";
