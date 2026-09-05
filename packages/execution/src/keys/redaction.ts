/**
 * Removing key material from anything that might be written down.
 *
 * `@mandate/observability` redacts by FIELD PATH, which protects a log line built from
 * named fields and nothing else. Two very common shapes slip straight past it:
 *
 *  - `log.info({ config }, "started")` — the redact path `privateKey` is anchored at the
 *    root of the logged object, so a key nested one level deeper is printed in full.
 *  - `error.message` — viem embeds the JSON-RPC request body in its messages, and pino has
 *    no way to know that a `msg` string contains 32 bytes it should not print.
 *
 * So the defence here is value-based, not name-based: given the actual secret, strip every
 * form of it out of every string that could escape. It is deliberately narrow. It does NOT
 * blanket-redact 64-character hex runs, because transaction and block hashes are the same
 * shape and are the most useful thing in a chain diagnostic — a redactor that eats them
 * makes operators turn it off, which is worse than not having one.
 *
 * What this cannot do, stated plainly: a JavaScript string is immutable and garbage
 * collected, so the key stays in the heap until it is collected and may be written to a
 * core dump, a heap snapshot, or swap. Nothing in userland fixes that. This bounds
 * ACCIDENTAL DISCLOSURE — logs, error reports, crash handlers — and it is not a substitute
 * for the key living in a KMS or an HSM that never hands it to this process at all.
 */

export const REDACTED = "[redacted]";

/** Bounds on what a scrubbed error may carry forward, so a scrub cannot become a payload. */
const MAX_TEXT = 4000;
const MAX_CAUSE_DEPTH = 4;
const MAX_FIELDS = 12;

/**
 * Every spelling of the same secret an upstream library might produce.
 *
 * viem accepts `0x`-prefixed lowercase and hands the same string back in errors, but a key
 * that reached this process from an env file may be uppercase, and code that strips the
 * prefix before hashing produces the bare 64 characters. All of those are the key.
 */
function variants(secret: string): string[] {
  const trimmed = secret.trim();
  // Below 16 characters a "secret" is more likely to be a placeholder than a key, and
  // replacing a short string globally would shred unrelated text.
  if (trimmed.length < 16) return [];
  const bare = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  const forms = new Set<string>();
  for (const body of [bare, bare.toLowerCase(), bare.toUpperCase()]) {
    forms.add(body);
    forms.add(`0x${body}`);
    forms.add(`0X${body}`);
  }
  // Longest first: replacing the bare body before the prefixed one would leave a stray
  // "0x[redacted]" that still reveals the value was a hex secret. Cosmetic, but the
  // shorter replacement running first also breaks the longer match.
  return [...forms].sort((a, b) => b.length - a.length);
}

/**
 * A scrubber bound to a fixed set of secrets.
 *
 * Constructed once next to the key and passed around by reference. It holds the secrets in
 * a `#private` field: a TypeScript `private` modifier is erased at runtime, leaving an
 * ordinary enumerable property that `console.log`, `JSON.stringify` and pino all print. A
 * `#` field is invisible to every one of them. That difference is the whole reason this
 * class exists rather than a free function over a captured array.
 */
export class Redactor {
  readonly #forms: readonly string[];

  constructor(secrets: readonly string[]) {
    this.#forms = secrets.flatMap(variants);
  }

  /** True when there is nothing to strip. Lets callers skip work, never skip safety. */
  get empty(): boolean {
    return this.#forms.length === 0;
  }

  /**
   * Strip every secret out of a string and bound its length.
   *
   * Truncation is part of redaction, not a nicety: an upstream error can carry a whole
   * JSON-RPC batch, and a log line assembled from one is how a "safe" diagnostic becomes
   * an exfiltration channel for everything else in the request.
   */
  text(value: string): string {
    let out = value;
    for (const form of this.#forms) out = out.split(form).join(REDACTED);
    return out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT - 1)}…` : out;
  }

  /**
   * Rebuild an error with nothing secret in it.
   *
   * A NEW error is constructed rather than the original mutated, and this matters more than
   * it looks. `error.message` is only the first place the key appears: V8 renders the
   * message into `error.stack` when the error is created, viem copies it into
   * `shortMessage` and `details`, and `error.cause` holds the original object with its own
   * untouched message. Scrubbing `message` alone leaves three copies behind. So the message,
   * the stack, the cause chain and the string-valued own properties are all rebuilt.
   *
   * The stack is carried over (scrubbed) rather than regenerated, because a stack that
   * points at this function instead of at the failing RPC call is worthless.
   */
  error(value: unknown, depth = 0): Error {
    try {
      if (!(value instanceof Error)) {
        // A thrown non-Error is not stringified: it can be a viem request object holding
        // the signed transaction, or a huge parsed body. Its type is all we report.
        if (typeof value === "string") return new Error(this.text(value));
        return new Error(`Non-error value thrown (${value === null ? "null" : typeof value})`);
      }
      const scrubbed = new Error(this.text(value.message));
      scrubbed.name = value.name;
      if (value.stack !== undefined) scrubbed.stack = this.text(value.stack);
      const cause: unknown = (value as { cause?: unknown }).cause;
      if (cause !== undefined && depth < MAX_CAUSE_DEPTH)
        (scrubbed as { cause?: unknown }).cause = this.error(cause, depth + 1);
      let copied = 0;
      for (const key of Object.keys(value)) {
        if (copied >= MAX_FIELDS) break;
        if (key === "stack" || key === "message" || key === "cause") continue;
        const field: unknown = (value as unknown as Record<string, unknown>)[key];
        // Only scalars travel. An object-valued field is exactly where a library parks the
        // request it was about to send, and copying it wholesale defeats the point.
        if (typeof field === "string")
          (scrubbed as unknown as Record<string, unknown>)[key] = this.text(field);
        else if (typeof field === "number" || typeof field === "boolean")
          (scrubbed as unknown as Record<string, unknown>)[key] = field;
        else continue;
        copied += 1;
      }
      return scrubbed;
    } catch {
      // A getter that throws, a proxy, a frozen error: none of those may stop a scrub, and
      // returning the original would hand the caller the thing we exist to withhold.
      return new Error("Redaction failed; the original error was discarded unread.");
    }
  }
}

/** A redactor that strips nothing. For call sites with no secret in scope. */
export const NO_SECRETS = new Redactor([]);
