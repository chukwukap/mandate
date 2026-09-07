import { z } from "zod";
import type { Hex } from "../index.js";

/**
 * Every leaf value that crosses the HTTP boundary, defined once.
 *
 * The API and apps/web both parse against these, so a rule that lives here cannot drift between
 * the two sides of a request. Anything looser than the database CHECK behind it would let a row
 * fail at INSERT with a 500 instead of at the edge with a 400; anything tighter would reject a
 * value the database already holds, which is worse — it makes stored strategies unreadable.
 */

/** Arbitrary-length calldata or signature bytes. Whole bytes only: "0x0" is not hex data. */
export const hexSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);

/**
 * A 20-byte address, case-insensitive.
 *
 * Deliberately NOT lowercased or checksum-validated. The catalogue in packages/evm stores
 * EIP-55 checksummed addresses (AAPLc is 0xb200000000000000000000C2e324d24d7eEcd1fb), so a
 * lowercase-only rule would reject the API's own asset list. Use `lowercaseAddressSchema` where
 * a canonical form is required for comparison — the `drafts.account` column has a
 * `~ '^0x[0-9a-f]{40}$'` CHECK, so anything written there must be normalised first.
 */
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** The same address, normalised for equality. Wallet comparisons must never be case-sensitive. */
export const lowercaseAddressSchema = addressSchema.transform(
  (value) => value.toLowerCase() as Hex,
);

/** An address in the `0x${string}` shape the viem-facing types use. */
export const hexAddressSchema = addressSchema.transform((value) => value as Hex);
export const hexDataSchema = hexSchema.transform((value) => value as Hex);

/**
 * A wallet signature.
 *
 * The 32770 ceiling is inherited unchanged: an ERC-6492 wrapper around a smart-account
 * signature carries the factory calldata that would deploy the account, so a Coinbase Smart
 * Wallet signature is kilobytes, not 65 bytes. Capping at 65 bytes would reject exactly the
 * accounts that are eligible for automatic mode.
 */
export const signatureSchema = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
  .max(32770);

/** An application-owned UUID: user, draft, instance, permission, evaluation, execution. */
export const idSchema = z.uuid();

/** A sha256 digest as lowercase hex without a 0x prefix — `artifact_id` and `render_sha256`. */
export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const modeSchema = z.enum(["manual", "auto"]);
export const statusSchema = z.enum(["armed", "paused", "halted", "ended"]);
export const sideSchema = z.enum(["buy", "sell"]);
export const walletKindSchema = z.enum(["eoa", "base_account", "contract"]);
export const permissionStatusSchema = z.enum([
  "prepared",
  "signed",
  "active",
  "revoked",
  "expired",
]);
/** Mirrors the `execution_status_valid` CHECK added in migration 0004. */
export const executionStatusSchema = z.enum([
  "signal",
  "admitted",
  "pending",
  "confirmed",
  "reverted",
  "cancelled",
  "refunded",
  "recovery_required",
]);
/** Mirrors `transaction_leg_valid`. The lifecycle's stage is always one of these or "done". */
export const transactionLegSchema = z.enum(["fund", "approve", "swap", "reset", "refund"]);
export const transactionStatusSchema = z.enum(["signed", "confirmed", "reverted"]);

/** A catalogue symbol such as AAPLc. Bounded so an unknown-symbol probe cannot carry a payload. */
export const symbolSchema = z.string().min(1).max(24);

/** Basis points of a whole, e.g. an order size expressed as a fraction of equity. */
export const bpsSchema = z.int().min(1).max(10_000);
/**
 * Slippage tolerance. Capped at 500 bps because packages/evm refuses any route more than 5%
 * from the Chainlink reference; a larger tolerance here would be silently unusable.
 */
export const slippageBpsSchema = z.int().min(1).max(500);

/**
 * A decimal quantity as a string. Never a JSON number.
 *
 * 100.000001 USDC is exact as a string and is not representable as a float64, and this value is
 * a user's spend cap. The bounds match `decimal` in packages/strategy/src/strategy.ts, which is
 * what actually validates a signed envelope, so a cap that round-trips through the API is
 * accepted by the artifact validator too.
 */
export const decimalSchema = z.string().regex(/^-?\d{1,40}(?:\.\d{1,28})?$/);

/** A non-negative decimal quantity with at most six places — a USDC amount. */
export const usdcAmountSchema = z.string().regex(/^\d{1,30}(?:\.\d{1,6})?$/);

/**
 * The amount accepted by POST /v1/market/quote.
 *
 * Eighteen places, not six: a sell is denominated in the base asset, and while every B20 token
 * in the catalogue has 8 decimals the endpoint has always accepted the wider form.
 */
export const quoteAmountSchema = z.string().regex(/^\d{1,30}(?:\.\d{1,18})?$/);

/**
 * An integer amount in a token's smallest unit.
 *
 * No leading zeros: the worker compares this string against `units(...).toString()` by exact
 * equality before it will execute, so "0100" and "100" are the same number but not the same
 * authorization, and the mismatch would surface as an opaque refusal after the user had signed.
 */
export const rawUnitsSchema = z.string().regex(/^(?:0|[1-9]\d{0,77})$/);

/**
 * A Unix timestamp in seconds.
 *
 * The upper bound is uint48, which is what SpendPermissionManager packs `period`, `start` and
 * `end` into. A value above it encodes fine in JSON and reverts onchain.
 */
export const unixSecondsSchema = z
  .int()
  .min(0)
  .max(2 ** 48 - 1);

/**
 * An instant, accepted as either a Date or an offset ISO string, always emitted as ISO.
 *
 * Both forms are real. Server-side views hand back `instance.createdAt` — a Date, which Fastify
 * serialises — while a client parsing the same response sees a string. One schema that accepts
 * both is what lets a single response schema describe the value on both sides of the wire.
 * The cost is that `z.toJSONSchema` cannot represent the Date branch, which is why every
 * OpenAPI conversion must go through `jsonSchema()` in ./openapi.ts.
 */
export const timestampSchema = z
  .union([z.date(), z.iso.datetime({ offset: true })])
  .transform((value) => (typeof value === "string" ? value : value.toISOString()));

/** The same instant where null is a real answer: `last_tick_at` before the first tick. */
export const nullableTimestampSchema = timestampSchema.nullable();

export type Mode = z.infer<typeof modeSchema>;
export type InstanceStatus = z.infer<typeof statusSchema>;
export type Side = z.infer<typeof sideSchema>;
export type WalletKind = z.infer<typeof walletKindSchema>;
export type PermissionStatus = z.infer<typeof permissionStatusSchema>;
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export type TransactionLeg = z.infer<typeof transactionLegSchema>;
export type TransactionStatus = z.infer<typeof transactionStatusSchema>;
