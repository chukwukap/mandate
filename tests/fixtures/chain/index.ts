/**
 * Deterministic Base mainnet fixtures: recorded quotes, Chainlink rounds, receipts, ERC20
 * metadata, and a fake chain client the tests inject in place of `BaseReader`.
 *
 * Nothing here opens a socket, reads the wall clock, or depends on the order tests run in.
 * Every clock is an explicit instant from `CLOCKS`, and every chain answer is a recorded value
 * fed through the production decision it is meant to exercise.
 *
 * Imports are deep relative paths rather than `@mandate/*`: the workspace packages are only
 * linked into `apps/*` and `packages/*`, and `tests/` has no `node_modules` of its own, so a
 * bare specifier does not resolve from here.
 */
export type { FixtureAsset } from "./catalogue.js";
export {
  assetOf,
  B20_ASSETS,
  CHAIN_ID,
  FEED_DECIMALS,
  plainAsset,
  QUOTER,
  SHIPPED_ASSETS,
  SLIPSTREAM_FACTORY,
  SLIPSTREAM_SWAP_ROUTER,
  SPEND_MANAGER,
  TICK_SPACINGS,
  USDC,
  USDC_DECIMALS,
} from "./catalogue.js";
export type {
  ChainCalls,
  ChainFaults,
  FakeChainOptions,
  MessageSignature,
  PermissionState,
} from "./client.js";
export { FakeChainClient } from "./client.js";
export type { BalanceSheet, TokenMetadata } from "./erc20.js";
export {
  ACCOUNTS,
  balanceKey,
  balanceOf,
  balanceSheet,
  balanceString,
  DECIMALS_TRAP,
  DEFAULT_BALANCES,
  TOKENS,
  tokenOf,
} from "./erc20.js";
export type { FeedFixture, RecordedRound } from "./feeds.js";
export {
  AGES,
  answerOf,
  CLOCKS,
  FEEDS,
  feedOf,
  marketRounds,
  NAV_USD,
  NVDA_SPLIT_MULTIPLIER,
  readingOf,
  roundAt,
} from "./feeds.js";
export type {
  Pricebook,
  ProbeOutcome,
  QuoteFixture,
  RecordedProbe,
  SplitProbes,
} from "./quotes.js";
export { fillAt, PRICEBOOKS, probesFor, QUOTES, quoteOf, splitProbes } from "./quotes.js";
export type { ReceiptFixture, RecordedLog, RecordedReceipt, Transfer } from "./receipts.js";
export {
  CONFIRMATIONS,
  confirmationsOf,
  creditedTo,
  decodeTransfer,
  ORDER,
  RECEIPTS,
  receiptOf,
  reorged,
  TRANSFER_TOPIC,
  transferLog,
} from "./receipts.js";
