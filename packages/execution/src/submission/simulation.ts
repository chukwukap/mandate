/**
 * Telling "this transaction would fail" apart from "we could not ask".
 *
 * These two arrive at a `catch` looking identical — both are an exception from the same
 * client method — and confusing them is expensive in both directions. Treating a revert as
 * a transport blip means retrying a doomed transaction on a timer, paying gas each time.
 * Treating a rate limit as a revert cancels a perfectly good order and, once the funding
 * leg has already run, sends the user's money on a round trip through a server wallet for
 * nothing.
 *
 * The discriminator is duck-typed on purpose. `@mandate/execution` has no viem dependency
 * and must not acquire one, so nothing here does an `instanceof` against a library class.
 * What it looks for instead is the JSON-RPC contract, which is stable across clients:
 * a call that reverts comes back as error code 3 with `data`, or as code -32000 whose
 * message says "execution reverted". Both are checked, along with viem's error `name`s,
 * because a client may surface either shape.
 */

/** The standard `Error(string)` selector every Solidity `require` with a message produces. */
const ERROR_STRING_SELECTOR = "0x08c379a0";
/** `Panic(uint256)`: an assertion, an overflow, a division by zero. */
const PANIC_SELECTOR = "0x4e487b71";

/** Solidity documentation, not inferred from any deployment. */
const PANIC_CODES: Record<string, string> = {
  "0x01": "assertion failed",
  "0x11": "arithmetic overflow or underflow",
  "0x12": "division or modulo by zero",
  "0x21": "invalid enum conversion",
  "0x22": "invalid storage byte array encoding",
  "0x31": "pop on an empty array",
  "0x32": "array index out of bounds",
  "0x41": "excessive memory allocation",
  "0x51": "call to an uninitialised internal function",
};

/**
 * viem class names that mean the EVM rejected the call, as strings.
 *
 * Matching on `name` rather than on the class keeps the dependency out; the cost is that a
 * viem rename would silently downgrade a revert to `unavailable`. That failure direction is
 * the safe one — the transaction is still not sent — and the JSON-RPC checks below catch
 * the same condition independently, so a rename degrades diagnostics, not safety.
 */
const REVERT_NAMES = new Set([
  "ContractFunctionRevertedError",
  "ExecutionRevertedError",
  "ContractFunctionZeroDataError",
  "RawContractError",
]);

const HEX = /^0x[0-9a-fA-F]*$/;

export type SimulationVerdict =
  | { readonly kind: "ok" }
  /** The EVM rejected it. Terminal: this must not be signed, and must not be retried. */
  | { readonly kind: "reverted"; readonly detail: string }
  /** We could not find out. Not sent, and safe to try again later. */
  | { readonly kind: "unavailable"; readonly detail: string };

/**
 * Flatten anything that came back from a contract into one short, printable line.
 *
 * Revert payloads are attacker-chosen bytes from an arbitrary contract: a decoded
 * `Error(string)` can carry newlines, ANSI escapes, or a megabyte of padding, and this
 * string ends up in `executions.reason`, which the API returns to users. Control characters
 * are stripped and the length is bounded here, at construction, because pino's redaction
 * works on field names and would not touch any of it.
 */
export function sanitize(text: string, limit = 200): string {
  const flat = text.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Walk an error's `cause` chain without assuming any library's class shapes. */
function* chain(error: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    yield current as Record<string, unknown>;
    current = (current as { cause?: unknown }).cause;
  }
}

/**
 * Pull revert returndata out of an error, wherever the client parked it.
 *
 * viem nests it as `error.data`, `error.data.data`, or on a `RawContractError` under
 * `cause.data`; a raw JSON-RPC error puts it at `error.data` directly. Rather than encode
 * one client's layout, every level of the cause chain is checked for a hex string that is
 * longer than the empty `0x`.
 */
export function revertData(error: unknown): string | null {
  for (const node of chain(error)) {
    const direct = node.data;
    const nested =
      direct !== null && typeof direct === "object"
        ? (direct as { data?: unknown }).data
        : undefined;
    for (const candidate of [direct, nested])
      if (typeof candidate === "string" && candidate.length > 2 && HEX.test(candidate))
        return candidate;
  }
  return null;
}

/** Read one 32-byte word out of ABI-encoded returndata as a bigint. `null` when short. */
function word(data: string, index: number): bigint | null {
  const start = 10 + index * 64;
  const slice = data.slice(start, start + 64);
  return slice.length === 64 ? BigInt(`0x${slice}`) : null;
}

/**
 * Decode a revert reason, or say honestly that it was not decoded.
 *
 * A custom error's selector is reported as four bytes and NOT guessed at. Inventing a
 * plausible name for an unknown selector attaches a confident wrong story to a
 * money-losing failure, which is strictly worse than a hex string an operator can look up.
 */
export function revertReason(data: string | null): string {
  if (data === null || data === "0x") return "The call reverted without a reason.";
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === PANIC_SELECTOR) {
    const code = word(data, 0);
    if (code === null) return "Panic (truncated).";
    const hex = `0x${code.toString(16).padStart(2, "0")}`;
    return `Panic(${hex}): ${PANIC_CODES[hex] ?? "unspecified panic code"}.`;
  }
  if (selector !== ERROR_STRING_SELECTOR)
    return `Custom error ${selector} (signature not resolved).`;
  const offset = word(data, 0);
  const length = word(data, 1);
  // The length prefix is attacker-controlled: a contract can claim gigabytes. Read at most
  // 256 bytes and only what the payload actually contains.
  if (offset !== 32n || length === null || length === 0n)
    return "The call reverted with an empty reason.";
  const bytes = Number(length > 256n ? 256n : length);
  // Two words follow the selector before the string itself: the offset, then the length.
  const body = data.slice(10 + 128, 10 + 128 + bytes * 2);
  if (body.length < bytes * 2) return "The call reverted with a truncated reason.";
  try {
    return sanitize(Buffer.from(body, "hex").toString("utf8"));
  } catch {
    return "The call reverted with an undecodable reason.";
  }
}

/**
 * Classify a thrown simulation failure.
 *
 * Ordered from most specific to least. Returndata is the strongest signal available — only
 * the EVM produces it — so it is checked first and short-circuits everything else.
 */
export function classifySimulationFailure(error: unknown): SimulationVerdict {
  const data = revertData(error);
  if (data !== null) return { kind: "reverted", detail: revertReason(data) };
  for (const node of chain(error)) {
    const name = typeof node.name === "string" ? node.name : "";
    if (REVERT_NAMES.has(name)) return { kind: "reverted", detail: revertReason(null) };
    const code = node.code;
    // JSON-RPC 3 is the "execution error" code and is only ever produced by the EVM.
    if (code === 3) return { kind: "reverted", detail: revertReason(null) };
    const message = typeof node.message === "string" ? node.message : "";
    // -32000 is the catch-all server error, so the code alone proves nothing; geth uses it
    // for "execution reverted", for "insufficient funds", and for a dozen unrelated faults.
    // Only the message narrows it, and only for reverts.
    if (code === -32000 && /execution reverted|always failing transaction/i.test(message))
      return { kind: "reverted", detail: revertReason(null) };
  }
  // Everything else — a timeout, a rate limit, a DNS failure, a 502 from the provider — is
  // an unanswered question, never an answer of "no". Deliberately no message is copied out:
  // a viem error message embeds the RPC URL and the whole request body.
  return {
    kind: "unavailable",
    detail: "The transaction could not be simulated; nothing was signed or sent.",
  };
}

/**
 * Simulate a call and return a verdict instead of throwing.
 *
 * The port's `simulate` must throw on revert; this is the only place that decides what a
 * throw meant, so every caller in the pipeline branches on a verdict rather than on an
 * error class it would have to keep in sync.
 */
export async function simulate(run: () => Promise<void>): Promise<SimulationVerdict> {
  try {
    await run();
    return { kind: "ok" };
  } catch (error) {
    return classifySimulationFailure(error);
  }
}
