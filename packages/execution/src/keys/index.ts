/**
 * Secret hygiene for the worker's logs.
 *
 * The worker no longer holds a wallet key — users' Privy embedded wallets sign their own orders
 * through a delegated signer — but it still handles a Privy authorization key and signed
 * transaction bytes, and neither may reach a log, an error or a crash report.
 */
export { NO_SECRETS, REDACTED, Redactor } from "./redaction.js";
