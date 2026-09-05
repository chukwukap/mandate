import type { z } from "zod";
import type {
  addressSchema,
  bpsSchema,
  decimalSchema,
  digestSchema,
  hexAddressSchema,
  hexDataSchema,
  hexSchema,
  idSchema,
  lowercaseAddressSchema,
  nullableTimestampSchema,
  quoteAmountSchema,
  rawUnitsSchema,
  signatureSchema,
  slippageBpsSchema,
  symbolSchema,
  timestampSchema,
  unixSecondsSchema,
  usdcAmountSchema,
} from "../schemas/primitives.js";

/**
 * The TypeScript name for every leaf value in ../schemas/primitives.ts.
 *
 * Each one is `z.infer` of the schema that validates it, never a parallel hand-written
 * declaration. A second declaration of the same shape does not stay in sync: the schema is
 * what actually rejects a request, so when the two disagree the type says one thing, the
 * validator does another, and the mismatch surfaces as a 400 nobody can reproduce from
 * reading the code. Tightening `usdcAmountSchema` here changes what `UsdcAmount` means
 * everywhere in the same commit, which is the only way that stays true.
 *
 * The names are a mechanical one-to-one map onto the schema names, so a reader can go from a
 * type back to the rule that produced it without searching. Nothing is renamed to read nicer.
 */

/**
 * The `0x`-prefixed string shape viem-facing code holds.
 *
 * Declared here rather than inferred because no schema can produce it: `addressSchema` is a
 * `z.string().regex(...)`, and zod infers `string` from that — the template literal only
 * appears on the schemas that carry an explicit transform (see `HexAddress` below).
 *
 * This is byte-identical to the alias currently in src/index.ts and the two coexist during the
 * handoff: identical aliases are mutually assignable, so a value crossing between them needs
 * no cast. index.ts should re-export this one and drop its copy.
 */
export type Hex = `0x${string}`;

/** Arbitrary-length hex bytes: calldata, a signature, an EIP-712 `extraData` field. */
export type HexBytes = z.infer<typeof hexSchema>;

/**
 * A 20-byte address as the request schema yields it: `string`, not `Hex`.
 *
 * That is the honest inference and it is deliberately left alone. `addressSchema` does not
 * transform, so a parsed address is a plain string, and widening this alias to `Hex` by hand
 * would let a value that never passed a transform be handed to viem as though it had.
 * Where the narrower shape is needed, parse with `hexAddressSchema` — do not cast.
 */
export type Address = z.infer<typeof addressSchema>;

/** An address parsed through the transforming schema, so `Hex` is earned rather than asserted. */
export type HexAddress = z.infer<typeof hexAddressSchema>;

/**
 * An address normalised to lowercase for equality.
 *
 * Structurally identical to `HexAddress`; the distinct name is the whole point, because the
 * `drafts.account` CHECK (`~ '^0x[0-9a-f]{40}$'`) accepts only this form and a checksummed
 * address written into that column fails at INSERT rather than at the edge.
 */
export type LowercaseAddress = z.infer<typeof lowercaseAddressSchema>;

/** Arbitrary hex bytes carrying the `Hex` shape, for calldata handed to viem. */
export type HexData = z.infer<typeof hexDataSchema>;

/**
 * A wallet signature. Not fixed at 65 bytes: an ERC-6492 wrapper around a Coinbase Smart
 * Wallet signature carries the account's deploy calldata and runs to kilobytes.
 */
export type Signature = z.infer<typeof signatureSchema>;

/** An application-owned UUID: user, draft, instance, permission, evaluation, execution. */
export type Id = z.infer<typeof idSchema>;

/** A sha256 digest, lowercase hex, no `0x` prefix — `artifact_id` and `render_sha256`. */
export type Digest = z.infer<typeof digestSchema>;

/** A catalogue symbol such as `AAPLc`. */
export type AssetSymbol = z.infer<typeof symbolSchema>;

/** Basis points of a whole, 1..10000. */
export type Bps = z.infer<typeof bpsSchema>;

/** Slippage tolerance in basis points, capped at the 500 bps reference band packages/evm enforces. */
export type SlippageBps = z.infer<typeof slippageBpsSchema>;

/**
 * A decimal quantity as a string, never a JSON number.
 *
 * 100.000001 USDC is exact as a string and is not representable as a float64, and this value
 * is a user's spend cap. Every money field in this system is one of these or `RawUnits`.
 */
export type DecimalString = z.infer<typeof decimalSchema>;

/** A non-negative decimal with at most six places — a USDC amount in whole units. */
export type UsdcAmount = z.infer<typeof usdcAmountSchema>;

/** The wider decimal accepted by the quote endpoint, where the input may be the base asset. */
export type QuoteAmount = z.infer<typeof quoteAmountSchema>;

/**
 * An integer amount in a token's smallest unit, with no leading zeros.
 *
 * The worker compares this against `units(...).toString()` by exact string equality before it
 * will execute, so "0100" and "100" are the same number but not the same authorization.
 */
export type RawUnits = z.infer<typeof rawUnitsSchema>;

/** A Unix timestamp in seconds, bounded by uint48 — what SpendPermissionManager packs. */
export type UnixSeconds = z.infer<typeof unixSecondsSchema>;

/**
 * An instant on the wire: always an offset ISO string.
 *
 * `Timestamp` is the parsed (output) side and `TimestampInput` is what may be handed in. The
 * two genuinely differ and both are load-bearing: a server-side view passes `instance.createdAt`
 * — a `Date` — straight into a response schema, while a client parsing that same response sees
 * a string. Collapsing them to one alias makes one of those two call sites a type error for no
 * reason, so the split is exposed rather than smoothed over.
 */
export type Timestamp = z.infer<typeof timestampSchema>;
export type TimestampInput = z.input<typeof timestampSchema>;

/** The same instant where null is a real answer — `last_tick_at` before the first tick. */
export type NullableTimestamp = z.infer<typeof nullableTimestampSchema>;
export type NullableTimestampInput = z.input<typeof nullableTimestampSchema>;

/**
 * The closed vocabularies.
 *
 * Re-exported from the schema module rather than re-inferred here. `z.infer` of the same
 * schema twice produces the same type today, but two `export type X = z.infer<...>` lines are
 * still two declarations, and the point of this file is that there is exactly one.
 */
export type {
  ExecutionStatus,
  InstanceStatus,
  Mode,
  PermissionStatus,
  Side,
  TransactionLeg,
  TransactionStatus,
  WalletKind,
} from "../schemas/primitives.js";
