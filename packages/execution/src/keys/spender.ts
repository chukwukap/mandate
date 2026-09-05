import { type Hex, Problem } from "@mandate/contracts";
import { Redactor } from "./redaction.js";

/**
 * The one place the spender private key is allowed to exist in this system.
 *
 * Read `custody.ts` first: this key can move a user's USDC while an order is mid-flight,
 * so everything below is about making that key hard to leak by accident, not about
 * pretending it is not there.
 *
 * The rules this type enforces, and why each one is not paranoia:
 *
 *  1. The material lives in a `#private` field. TypeScript's `private` is a compile-time
 *     annotation only — at runtime it is an ordinary enumerable property, so `console.log`,
 *     `JSON.stringify`, `util.inspect` and pino all print it. A `#` field is invisible to
 *     every one of those. This is a real, verified difference in behaviour, not a style
 *     preference.
 *  2. `toString`, `toJSON` and the Node inspect hook are all overridden. Between them they
 *     cover template interpolation, structured logging, `JSON.stringify` and a REPL dump.
 *  3. Nothing returns the material. `use()` hands it to a callback and scrubs anything that
 *     callback throws, because the libraries that consume a key put their inputs in their
 *     error messages, and an error message becomes a stack, a log line and a bug report.
 *  4. The address is derived by an INJECTED function. This package has no secp256k1
 *     implementation and must not gain one; the worker passes viem's
 *     `privateKeyToAccount`. That keeps signing dependencies out of the package that owns
 *     the custody policy.
 *
 * What it does not do: a JavaScript string cannot be wiped. Once the key is in the heap it
 * is there until the collector runs, and a core dump, a heap snapshot or swapped-out memory
 * can contain it. `forget()` drops the last reference this process holds, which is the most
 * a managed runtime can offer. The real fix is to never hold the key — sign in a KMS or an
 * HSM — and that is not what this deployment does today.
 */

/** `0x` + 64 hex characters. Anything else is not a secp256k1 private key. */
const KEY_SHAPE = /^0x[0-9a-fA-F]{64}$/;

/**
 * The order of the secp256k1 group.
 *
 * A private key must be in [1, n). Values outside that range are not "unlikely", they are
 * invalid: 0 has no public key, and anything at or above n either wraps to a different key
 * or is rejected outright by the signing library, whose rejection message tends to quote
 * the offending value. Checking here means a misconfigured key fails with a message that
 * contains nothing, rather than with one that contains the key.
 */
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Derives the address a key controls. `(k) => privateKeyToAccount(k).address` in the worker. */
export type DeriveAddress = (key: Hex) => Hex | Promise<Hex>;

export type SpenderKeyOptions = {
  /** The raw key. Prefer `takeEnvKey` so it does not also remain in `process.env`. */
  readonly material: string;
  /**
   * `SPENDER_ADDRESS`. When present the derived address must match it exactly.
   *
   * This is the check that catches the single worst configuration mistake available here:
   * a key that is valid but belongs to a DIFFERENT wallet than the one every stored spend
   * permission names. Without the check the worker starts, signs, and every `fund` call
   * reverts inside SpendPermissionManager — after the order has already been admitted and
   * the user's budget counters have been reserved for a trade that can never run.
   */
  readonly expectedAddress?: string | undefined;
  readonly derive: DeriveAddress;
};

/** Refusals here are 503: the worker is configured wrong, so it cannot execute at all. */
function unusable(detail: string): Problem {
  return new Problem(503, "spender-key-unusable", "Spender key unusable", detail);
}

export class SpenderKey {
  /** Not `private readonly`: see rule 1 above. This must be a runtime-private field. */
  readonly #material: Hex;
  #forgotten = false;

  /** The public address this key controls. Safe to log, and the only identifier that is. */
  readonly address: Hex;

  /** Scrubs this key out of arbitrary text and errors. Share it with anything that logs. */
  readonly redactor: Redactor;

  private constructor(material: Hex, address: Hex) {
    this.#material = material;
    this.address = address;
    this.redactor = new Redactor([material]);
  }

  /**
   * Validate, derive and bind a key.
   *
   * Every failure path throws a Problem whose detail is written by hand. No branch
   * interpolates the material, and the derive callback's own errors are scrubbed before
   * they are allowed to propagate — `privateKeyToAccount` raises `InvalidHexError` with the
   * offending string in the message, and that string is the key.
   */
  static async load(options: SpenderKeyOptions): Promise<SpenderKey> {
    const material = options.material.trim();
    if (!KEY_SHAPE.test(material))
      throw unusable("The spender key must be 0x followed by 64 hexadecimal characters.");
    const scalar = BigInt(material);
    if (scalar === 0n || scalar >= SECP256K1_ORDER)
      throw unusable("The spender key is not a valid secp256k1 scalar.");
    const key = material as Hex;
    const guard = new Redactor([key]);
    let address: Hex;
    try {
      address = await options.derive(key);
    } catch (error) {
      // The scrubbed error is attached as the cause so an operator still sees WHICH library
      // rejected the key, with the value taken out of it.
      throw Object.assign(unusable("The spender key could not be converted into an address."), {
        cause: guard.error(error),
      });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address))
      throw unusable("The spender key derived something that is not an address.");
    const expected = options.expectedAddress;
    if (expected !== undefined && expected.toLowerCase() !== address.toLowerCase())
      // Both values are public addresses, so naming them is safe and is the only way an
      // operator can tell which of the two settings is the wrong one.
      throw unusable(
        `The spender key controls ${address.toLowerCase()}, but the configured spender is ${expected.toLowerCase()}.`,
      );
    return new SpenderKey(key, address.toLowerCase() as Hex);
  }

  /**
   * Run one operation with the key.
   *
   * `purpose` is a short caller-supplied label ("sign fund transaction") that gives a
   * failure somewhere to point without the key going anywhere. The callback's result is
   * returned untouched; its errors are rebuilt with every trace of the key removed,
   * including the cause chain and the stack, and then re-thrown.
   *
   * Deliberately not a getter. A getter would let the key be assigned to a variable, put in
   * an object, and logged, and no amount of documentation prevents that. Passing it into a
   * callback keeps the reference on the stack for exactly the length of one call.
   */
  async use<T>(purpose: string, fn: (key: Hex) => Promise<T> | T): Promise<T> {
    if (this.#forgotten)
      throw unusable(`The spender key was released before "${purpose}" could use it.`);
    try {
      return await fn(this.#material);
    } catch (error) {
      const scrubbed = this.redactor.error(error);
      scrubbed.message = `${purpose}: ${scrubbed.message}`;
      throw scrubbed;
    }
  }

  /**
   * Drop this process's reference to the key.
   *
   * Honest about what it is: after this the object refuses to sign, and the string becomes
   * garbage. It is not an erasure — the bytes stay in the heap until they are collected and
   * may be reachable from a dump before then. Called on shutdown so a long-lived process
   * that has stopped executing is not still holding a live signing capability.
   */
  forget(): void {
    this.#forgotten = true;
  }

  get released(): boolean {
    return this.#forgotten;
  }

  /** Template interpolation and `String(key)`. */
  toString(): string {
    return `SpenderKey(${this.address})`;
  }

  /** `JSON.stringify`, and pino's serialiser for an object with a `toJSON`. */
  toJSON(): { readonly spender: Hex; readonly key: "[redacted]" } {
    return { spender: this.address, key: "[redacted]" };
  }

  /** `console.log`, `util.inspect`, and pino's fallback for a plain object. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/**
 * Read a secret out of the environment and remove it from the environment.
 *
 * `delete process.env.X` in Node calls `unsetenv(3)`, so the variable really leaves the
 * process environment: it stops appearing in `/proc/self/environ`, it is not inherited by
 * anything this process spawns, and a later `JSON.stringify(process.env)` — which is how a
 * "dump the config" debug endpoint or a crash reporter usually works — no longer sees it.
 *
 * It does not unread what has already been read. `loadWorkerConfig` copies
 * `WORKER_PRIVATE_KEY` into its returned object, so the config object still carries it and
 * still must not be logged wholesale; this only closes the ambient copy. Nor does it touch
 * the `.env` file, the orchestrator's secret store, or the parent shell.
 */
export function takeEnvKey(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  delete env[name];
  return value === "" ? undefined : value;
}
