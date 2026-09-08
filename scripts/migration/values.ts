import { createHash } from "node:crypto";
import type { Hex } from "../../packages/contracts/src/index.js";
import { Problem } from "../../packages/contracts/src/index.js";
import { whole } from "../../packages/strategy/src/evaluation/money.js";

/**
 * Column decoding for the legacy Rust schema.
 *
 * Every function here refuses rather than coerces. That is the whole point of the file: the
 * two databases disagree about representation in ways that are invisible at a glance —
 * addresses are `bytea` there and lowercase `0x` text here, money is `numeric` there and a
 * decimal string here, instants are `bigint` seconds there and millisecond `timestamptz`
 * here — and every one of those conversions has a wrong answer that still looks like a
 * plausible value. A migration that guesses produces rows nobody can later distinguish from
 * correct ones.
 */

function bytes(value: unknown, subject: string): Uint8Array {
  // `node-postgres` decodes bytea to a Buffer, PGlite to a Uint8Array, and a hand-written
  // fixture may carry the `\x...` text form. All three are legitimate inputs here.
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    const hex = value.startsWith("\\x")
      ? value.slice(2)
      : value.startsWith("0x")
        ? value.slice(2)
        : value;
    if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0)
      throw new Problem(
        422,
        "migration-value",
        "Unreadable byte string",
        `The legacy ${subject} column is not a hex byte string.`,
      );
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1)
      out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  throw new Problem(
    422,
    "migration-value",
    "Unreadable byte string",
    `The legacy ${subject} column is ${value === null ? "null" : typeof value}, not bytes.`,
  );
}

/** Lowercase `0x` hex, any length. Used for permission hashes and `extraData`. */
export function hex(value: unknown, subject: string): Hex {
  const raw = bytes(value, subject);
  let out = "0x";
  for (const byte of raw) out += byte.toString(16).padStart(2, "0");
  return out as Hex;
}

/**
 * A 20-byte address as lowercase `0x` hex.
 *
 * Lowercase, not EIP-55 checksummed: `drafts.account` carries a `~ '^0x[0-9a-f]{40}$'` check
 * constraint, the account is inside the artifact digest and the confirm message, and a
 * checksummed string would produce a different digest for the same wallet. One canonical
 * casing or the signature verification at arming time compares two different strings.
 */
export function address(value: unknown, subject: string): Hex {
  const raw = bytes(value, subject);
  if (raw.length !== 20)
    throw new Problem(
      422,
      "migration-value",
      "Invalid address",
      `The legacy ${subject} column holds ${raw.length} bytes; an address is 20.`,
    );
  return hex(raw, subject);
}

/**
 * A `raw_amount` column as an exact decimal string in whole units.
 *
 * The legacy domain is unconstrained `numeric` with a `VALUE = trunc(VALUE)` check, so a
 * well-formed row is always an integer — but the check was added after the type was widened
 * precisely because `numeric(40,0)` had been silently ROUNDING fractional raw units. A row
 * written before that fix can still hold `10.5`. Refusing it is the only safe answer: the
 * fraction is evidence that something upstream scaled wrongly, and rounding it here would
 * destroy that evidence while producing a cap the user never agreed to.
 *
 * Also refuses exponent notation. PostgreSQL does not emit it for `numeric`, but a fixture
 * or a JSON round trip can, and `BigInt("5e7")` throws while `Number("5e7")` silently
 * succeeds with a float — which is exactly the class of bug this codebase bans.
 */
export function rawAmount(value: unknown, decimals: number, subject: string): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new Problem(
      422,
      "migration-value",
      "Invalid scale",
      `The legacy ${subject} scale of ${String(decimals)} is not a usable decimal count.`,
    );
  const text =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number"
        ? String(value)
        : value;
  if (typeof text !== "string" || !/^\d+$/.test(text))
    throw new Problem(
      422,
      "migration-value",
      "Invalid raw amount",
      `The legacy ${subject} column is "${String(value)}"; a raw amount must be a non-negative integer.`,
    );
  return whole(BigInt(text), decimals);
}

/** A `bigint` (or `int`) column as a JavaScript number, refusing anything unsafe. */
export function integer(value: unknown, subject: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed))
    throw new Problem(
      422,
      "migration-value",
      "Invalid integer",
      `The legacy ${subject} column is "${String(value)}"; an exact integer is required.`,
    );
  return parsed;
}

/**
 * Unix seconds to an ISO 8601 instant with an explicit offset.
 *
 * `capsSchema.expires_at` is `z.iso.datetime({ offset: true })`, and `Date#toISOString`
 * always emits `Z`, which satisfies it. The bound is not decorative: 0 means the epoch,
 * which every downstream expiry check reads as "expired forever", and a value past year
 * 275760 makes `new Date` produce `Invalid Date` whose `toISOString` throws inside whatever
 * happens to call it next.
 */
export function isoFromUnixSeconds(value: unknown, subject: string): string {
  const seconds = integer(value, subject);
  if (seconds <= 0 || seconds > 253_402_300_799)
    throw new Problem(
      422,
      "migration-value",
      "Invalid timestamp",
      `The legacy ${subject} column is ${String(seconds)}; expected Unix seconds inside year 1970-9999.`,
    );
  return new Date(seconds * 1000).toISOString();
}

/** A `timestamptz` column as a Date. Drivers already decode it; a string is still accepted. */
export function instant(value: unknown, subject: string): Date {
  const date =
    value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime()))
    throw new Problem(
      422,
      "migration-value",
      "Invalid timestamp",
      `The legacy ${subject} column is not a readable timestamp.`,
    );
  return date;
}

/** A `timestamptz` column that may be null. */
export function optionalInstant(value: unknown, subject: string): Date | undefined {
  return value === null || value === undefined ? undefined : instant(value, subject);
}

/** A non-empty text column. */
export function text(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Problem(
      422,
      "migration-value",
      "Missing text",
      `The legacy ${subject} column is empty.`,
    );
  return value;
}

/**
 * A deterministic UUID derived from stable legacy identifiers.
 *
 * Deterministic on purpose. The three operations an operator actually performs are
 * "rehearse", "roll back" and "run it again"; with random ids the third would insert a
 * duplicate set of drafts beside the first rather than colliding harmlessly on a unique key.
 * `randomUUID()` would make the import idempotent only for as long as the journal survives,
 * which is exactly the assumption a rollback plan may not make.
 *
 * The version and variant nibbles are forced so the result is a well-formed v4-shaped UUID.
 * PostgreSQL stores any 128 bits, but tooling that parses a version out of one should not
 * see a value it cannot name.
 */
export function deterministicUuid(namespace: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256")
    .update([namespace, ...parts].join(" "))
    .digest("hex");
  const variant = ((Number.parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  const flat = `${hash.slice(0, 12)}4${hash.slice(13, 16)}${variant}${hash.slice(17, 32)}`;
  return `${flat.slice(0, 8)}-${flat.slice(8, 12)}-${flat.slice(12, 16)}-${flat.slice(16, 20)}-${flat.slice(20, 32)}`;
}
