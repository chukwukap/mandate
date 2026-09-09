/**
 * The shared type vocabulary: everything the API, the worker and the web app must agree on.
 *
 * Two rules hold across this directory.
 *
 * Every type that has a schema is `z.infer` of it. Not a copy that happens to match — the
 * inference itself, so tightening a rule in ../schemas changes the type in the same commit.
 * Two declarations of one shape drift, and the drift lands as a runtime validation failure
 * with no line of code to blame.
 *
 * Every type that cannot have a schema is here because it is a fact about the domain rather
 * than a fact about a request: which statuses the scheduler picks up, which legs may run after
 * a user has paused, which order states promise that no money moved. Those questions have one
 * right answer, they are asked in three packages, and before this directory each package
 * answered them from its own hand-written array.
 *
 * Named exports throughout rather than `export *`: a star export makes an accidental collision
 * between two modules silently drop a name, and this barrel exists to be depended on.
 */

export type {
  Asset,
  AssetCatalogue,
  DexFeedUri,
  FeedUri,
  FeedValues,
  OracleFeedUri,
} from "./assets.js";
export {
  EXECUTION_STATUSES,
  INSTANCE_STATUSES,
  isExecutionStatus,
  isInstanceStatus,
  isMode,
  isSide,
  isTransactionLeg,
  isTransactionStatus,
  isWalletKind,
  MODES,
  SIDES,
  TRANSACTION_LEGS,
  TRANSACTION_STATUSES,
  WALLET_KINDS,
} from "./enums.js";
export type { ExecutionDisposition, ExecutionStage } from "./executions.js";
export {
  executionDisposition,
  FORWARD_LEGS,
  guaranteesNoOnchainSpend,
  isSettledExecutionStatus,
  isUnwindLeg,
  NO_ONCHAIN_SPEND_STATUSES,
  SETTLED_EXECUTION_STATUSES,
  UNWIND_LEGS,
} from "./executions.js";
export type {
  EvaluationOutcome,
  InstanceDisposition,
  LifecycleAction,
  TerminalInstanceStatus,
} from "./instances.js";
export {
  EVALUATION_OUTCOMES,
  EXPIRY_HALT_REASON,
  instanceDisposition,
  isEvaluationOutcome,
  isTerminalInstanceStatus,
  isTransientEvaluationOutcome,
  TERMINAL_INSTANCE_STATUSES,
} from "./instances.js";
export type { BpsString, Denomination, Price, TokenAmount, TokenRef } from "./money.js";
export {
  BPS_SCALE,
  denominations,
  EQUITY_DECIMALS,
  inputDecimals,
  outputDecimals,
  QUOTE_DECIMALS,
  WEI_DECIMALS,
} from "./money.js";
export type {
  Address,
  AssetSymbol,
  Bps,
  DecimalString,
  Digest,
  ExecutionStatus,
  Hex,
  HexAddress,
  HexBytes,
  HexData,
  Id,
  InstanceStatus,
  LowercaseAddress,
  Mode,
  NullableTimestamp,
  NullableTimestampInput,
  QuoteAmount,
  RawUnits,
  Side,
  Signature,
  SlippageBps,
  Timestamp,
  TimestampInput,
  TransactionLeg,
  TransactionStatus,
  UnixSeconds,
  UsdcAmount,
  WalletKind,
} from "./primitives.js";
