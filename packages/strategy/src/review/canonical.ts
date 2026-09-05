import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted, arrays in order, no whitespace.
 *
 * This is the provenance root of everything the user signs. Two artifacts that
 * differ in any meaningful way must produce different text, and two encodings of the
 * same artifact must produce identical text regardless of key order — a plan read
 * back out of JSONB does not preserve the insertion order it was written with.
 *
 * Values it refuses are the ones that would silently collide:
 *
 * - `Date` has no enumerable own keys, so `Object.entries` renders it `{}`; two
 *   artifacts differing only in a timestamp would share an id. Callers pass
 *   `expiresAt.toISOString()` for exactly this reason, and this makes forgetting
 *   that a loud failure instead of a silent one.
 * - `NaN` and `Infinity` both stringify to `null`, colliding with an actual null.
 * - `undefined`, functions and symbols stringify to `undefined` inside an object and
 *   `null` inside an array, so `{a: 1}` and `{a: 1, b: undefined}` are one value
 *   here but two different rows in the database.
 * - `Map`, `Set` and `bigint` are either empty objects or a throw from JSON.stringify.
 *
 * Every one of those is a bug in the caller, not a value to encode. Throwing turns a
 * silent commitment collision into a failed request.
 */
export function canonical(value: unknown): string {
  return encode(value, "$", new Set());
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value))
        throw new Error(`Cannot commit to a non-finite number at ${path}`);
      // Object.is separates -0 from 0; JSON.stringify(-0) is "0", so they would
      // otherwise be one commitment for two different numbers.
      return Object.is(value, -0) ? "-0" : JSON.stringify(value);
    case "bigint":
      throw new Error(`Cannot commit to a bigint at ${path}; pass a decimal string`);
    case "undefined":
      throw new Error(`Cannot commit to undefined at ${path}; omit the key instead`);
    case "function":
    case "symbol":
      throw new Error(`Cannot commit to a ${typeof value} at ${path}`);
  }

  const object = value as object;
  // A cycle would recurse until the stack blew; say what is actually wrong instead.
  if (seen.has(object)) throw new Error(`Cannot commit to a cyclic value at ${path}`);
  if (object instanceof Date)
    throw new Error(`Cannot commit to a Date at ${path}; pass an ISO 8601 string`);
  if (object instanceof Map || object instanceof Set)
    throw new Error(`Cannot commit to a ${object.constructor.name} at ${path}; pass plain JSON`);

  seen.add(object);
  try {
    if (Array.isArray(object))
      return `[${object.map((item, index) => encode(item, `${path}[${index}]`, seen)).join(",")}]`;
    const entries = Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${encode(item, `${path}.${key}`, seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

/** sha256 of the canonical form, lowercase hex. The identity of a reviewed artifact. */
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
