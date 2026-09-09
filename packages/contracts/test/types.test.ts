import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addressSchema,
  executionStatusSchema,
  hexAddressSchema,
  nullableTimestampSchema,
  rawUnitsSchema,
  timestampSchema,
} from "../src/schemas/primitives.js";
import type {
  Address,
  ExecutionStatus,
  HexAddress,
  InstanceStatus,
  NullableTimestamp,
  RawUnits,
  Timestamp,
  TimestampInput,
  TransactionLeg,
} from "../src/types/index.js";
import {
  denominations,
  EQUITY_DECIMALS,
  EVALUATION_OUTCOMES,
  EXECUTION_STATUSES,
  EXPIRY_HALT_REASON,
  executionDisposition,
  FORWARD_LEGS,
  guaranteesNoOnchainSpend,
  INSTANCE_STATUSES,
  inputDecimals,
  instanceDisposition,
  isEvaluationOutcome,
  isExecutionStatus,
  isSettledExecutionStatus,
  isTerminalInstanceStatus,
  isTransactionLeg,
  isUnwindLeg,
  MODES,
  NO_ONCHAIN_SPEND_STATUSES,
  outputDecimals,
  QUOTE_DECIMALS,
  SETTLED_EXECUTION_STATUSES,
  SIDES,
  TERMINAL_INSTANCE_STATUSES,
  TRANSACTION_LEGS,
  TRANSACTION_STATUSES,
  UNWIND_LEGS,
} from "../src/types/index.js";

const repo = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), "utf8");

/** Every TypeScript source under a repo-relative directory, as text. */
function sourcesUnder(path: string): string[] {
  return readdirSync(new URL(path, repo), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
}

/**
 * Extracts the members of one database CHECK constraint from the drizzle schema source.
 *
 * Read as text rather than imported: pulling in the schema module would make @mandate/database
 * — and through it drizzle and a postgres driver — a test-time dependency of a package whose
 * only dependency is zod. The point of the assertion is that two independent declarations of
 * one vocabulary agree, and text is enough to establish that.
 */
function checkMembers(source: string, name: string): string[] {
  const match = new RegExp(`check\\(\\s*"${name}",\\s*sql\`([^\`]*)\``).exec(source);
  const body = match?.[1];
  if (!body) throw new Error(`No CHECK named ${name} in the drizzle schema`);
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

/**
 * Every closed vocabulary is declared three times in this system: as a zod enum, as a database
 * CHECK, and as the union the code branches on. The union is inferred from the enum, so those
 * two cannot disagree. This is what stops the third from drifting.
 *
 * It is not hypothetical: migration 0004 widened `execution_status_valid` to add
 * `recovery_required`, and a status filter built from a stale copy of the list would have
 * silently excluded exactly the rows an operator most needs to find.
 */
test("the derived member lists match the database CHECK constraints", () => {
  const schema = read("packages/database/src/schema/index.ts");
  expect([...EXECUTION_STATUSES] as string[]).toEqual(
    checkMembers(schema, "execution_status_valid"),
  );
  expect([...INSTANCE_STATUSES] as string[]).toEqual(checkMembers(schema, "instance_status_valid"));
  expect([...TRANSACTION_STATUSES] as string[]).toEqual(
    checkMembers(schema, "transaction_status_valid"),
  );
  expect([...MODES] as string[]).toEqual(checkMembers(schema, "instance_mode_valid"));
});

/**
 * The one vocabulary the CHECK is deliberately wider than.
 *
 * Journals written under the retired spend-permission design carry fund, reset and refund
 * legs, and migration 0006 kept `transaction_leg_valid` wide so those rows stay readable. The
 * code's vocabulary is the two legs a user's own wallet signs today, so the relationship is
 * containment: everything the code can write, the database accepts — and the surplus is
 * exactly the retired set, so a new leg cannot be added to the schema and forgotten here.
 */
test("the journal CHECK accepts every current leg and only the retired ones besides", () => {
  const schema = read("packages/database/src/schema/index.ts");
  const accepted = checkMembers(schema, "transaction_leg_valid");
  for (const leg of TRANSACTION_LEGS) expect(accepted).toContain(leg);
  expect(accepted.filter((leg) => !isTransactionLeg(leg))).toEqual(["fund", "reset", "refund"]);
  expect([...TRANSACTION_LEGS]).toEqual(["approve", "swap"]);
});

test("the member lists are the schema's own options, copied and frozen", () => {
  expect([...EXECUTION_STATUSES]).toEqual(executionStatusSchema.options);
  // Not the same array: zod's `.options` is the validator's own, and a caller that sorted or
  // pushed onto it would be editing the rule every request in the process is parsed against.
  expect(EXECUTION_STATUSES).not.toBe(executionStatusSchema.options as readonly string[]);
  expect(Object.isFrozen(EXECUTION_STATUSES)).toBe(true);
  expect(() => (EXECUTION_STATUSES as ExecutionStatus[]).push("signal")).toThrow();
  expect(executionStatusSchema.options).toHaveLength(8);
});

test("membership guards narrow real strings and reject everything else", () => {
  expect(isExecutionStatus("recovery_required")).toBe(true);
  expect(isExecutionStatus("recovery-required")).toBe(false);
  expect(isExecutionStatus("")).toBe(false);
  expect(isTransactionLeg("swap")).toBe(true);
  expect(isTransactionLeg("done")).toBe(false); // "done" is a stage, never a journal leg.
  expect(SIDES).toEqual(["buy", "sell"]);
});

test("instance dispositions cover every status exactly once", () => {
  const buckets = new Map(INSTANCE_STATUSES.map((s) => [s, instanceDisposition(s)]));
  expect([...buckets]).toEqual([
    ["armed", "scheduled"],
    ["paused", "idle"],
    ["halted", "terminal"],
    ["ended", "terminal"],
  ]);
  // The scheduler's `due()` selects on status = 'armed'; nothing else may claim to be ticking.
  expect(INSTANCE_STATUSES.filter((s) => instanceDisposition(s) === "scheduled")).toEqual([
    "armed",
  ]);
});

test("isTerminalInstanceStatus agrees with the disposition and tolerates unknown input", () => {
  for (const status of INSTANCE_STATUSES)
    expect(isTerminalInstanceStatus(status)).toBe(instanceDisposition(status) === "terminal");
  expect([...TERMINAL_INSTANCE_STATUSES]).toEqual(["halted", "ended"]);
  // A value from a `text` column that no longer parses is treated as non-terminal, matching
  // what the repository does with one. Refusing to act on it would strand the instance.
  expect(isTerminalInstanceStatus("something-else")).toBe(false);
});

test("execution dispositions partition every status", () => {
  const grouped: Record<string, ExecutionStatus[]> = {};
  for (const status of EXECUTION_STATUSES) {
    const bucket = grouped[executionDisposition(status)] ?? [];
    bucket.push(status);
    grouped[executionDisposition(status)] = bucket;
  }
  expect(grouped).toEqual({
    signalled: ["signal"],
    working: ["admitted", "pending"],
    settled: ["confirmed", "reverted", "cancelled", "refunded"],
    operator: ["recovery_required"],
  });
  expect(EXECUTION_STATUSES.filter(isSettledExecutionStatus)).toEqual([
    ...SETTLED_EXECUTION_STATUSES,
  ]);
});

test("a manual signal is never settled and never worked", () => {
  // The lifecycle has no guard of its own against a signal: handed one it would approve and
  // swap a trade the user chose to place by hand. Both of these must stay false.
  expect(isSettledExecutionStatus("signal")).toBe(false);
  expect(executionDisposition("signal")).toBe("signalled");
});

test("the no-spend promise is only made where it is true", () => {
  expect([...NO_ONCHAIN_SPEND_STATUSES]).toEqual(["signal", "admitted", "cancelled"]);
  for (const status of NO_ONCHAIN_SPEND_STATUSES)
    expect(guaranteesNoOnchainSpend(status)).toBe(true);
  // `pending` means a transaction is signed and journaled and may still land, and `reverted`
  // is a receipt that burned the wallet's gas even though no token moved. Claiming "nothing
  // was spent" for either would be a lie told to a user about their own money.
  expect(guaranteesNoOnchainSpend("pending")).toBe(false);
  expect(guaranteesNoOnchainSpend("reverted")).toBe(false);
  expect(guaranteesNoOnchainSpend("confirmed")).toBe(false);
  expect(guaranteesNoOnchainSpend("recovery_required")).toBe(false);
});

test("the forward legs are the whole vocabulary, and nothing unwinds", () => {
  expect([...FORWARD_LEGS, ...UNWIND_LEGS].sort()).toEqual([...TRANSACTION_LEGS].sort());
  for (const leg of FORWARD_LEGS) expect(isUnwindLeg(leg)).toBe(false);
  // Order is load-bearing: the approval must precede the swap that spends it.
  expect([...FORWARD_LEGS]).toEqual(["approve", "swap"]);
  // There is no unwind path because nothing leaves the user's wallet until the swap moves it
  // into the pool in the same transaction that delivers the shares. An unwind leg appearing
  // here would mean money is transiting somewhere it can be stranded again.
  expect([...UNWIND_LEGS]).toEqual([]);
});

test("order scale follows the side, not the token that happens to be first", () => {
  // A buy spends USDC and receives the equity; a sell is the mirror. Assuming 18 decimals for
  // a B20 sell misprices the order by 1e10.
  expect(inputDecimals("buy", EQUITY_DECIMALS)).toBe(QUOTE_DECIMALS);
  expect(outputDecimals("buy", EQUITY_DECIMALS)).toBe(EQUITY_DECIMALS);
  expect(inputDecimals("sell", EQUITY_DECIMALS)).toBe(EQUITY_DECIMALS);
  expect(outputDecimals("sell", EQUITY_DECIMALS)).toBe(QUOTE_DECIMALS);
  expect(QUOTE_DECIMALS).toBe(6);
  expect(EQUITY_DECIMALS).toBe(8);
  for (const side of SIDES) {
    expect(inputDecimals(side, 8) + outputDecimals(side, 8)).toBe(QUOTE_DECIMALS + 8);
    expect(denominations(side).input).not.toBe(denominations(side).output);
  }
  expect(denominations("buy")).toEqual({ input: "quote", output: "base" });
});

/**
 * The evaluation vocabulary is written by the worker's admission gate and translated by the
 * API. Neither side imports the other, so the only thing keeping them in step is that both
 * spell the same seven strings — and a typo in either is invisible until a user is shown a
 * blank reason for a tick that did not trade.
 */
test("every failure the admission gate writes is a known evaluation outcome", () => {
  const written = new Set(
    sourcesUnder("packages/execution/src/").flatMap((source) =>
      [...source.matchAll(/failure = "([a-z-]+)"/g)].map((m) => m[1] as string),
    ),
  );
  // A zero-match run means the gate was refactored and this assertion silently stopped
  // checking anything, which is worse than a failure.
  expect(written.size).toBeGreaterThan(0);
  for (const outcome of written) expect(isEvaluationOutcome(outcome)).toBe(true);
  expect(EVALUATION_OUTCOMES).toContain("evaluated");
  expect(isEvaluationOutcome("Strategy expired")).toBe(false); // A refusal, not an outcome.
});

/**
 * Expiry is written by two independent writers — the API materialises it under the row lock
 * before deciding a lifecycle transition, and the worker's gate writes it on the tick that
 * crosses the deadline. Byte-identical or not at all: a near miss produces a history in which
 * two strategies stopped for the same reason under two different labels, and a support query
 * for one silently misses the other.
 */
test("nothing writes a near-miss variant of the expiry halt reason", () => {
  const sources = [...sourcesUnder("packages/execution/src/"), ...sourcesUnder("apps/api/src/")];
  const writers = sources.filter((source) => source.includes(`"${EXPIRY_HALT_REASON}"`));
  expect(writers.length).toBeGreaterThan(0);
  const variants = sources.flatMap((source) =>
    [...source.matchAll(/"([Ss]trategy (?:has )?expired[^"]*)"/g)].map((m) => m[1] as string),
  );
  expect(new Set(variants)).toEqual(new Set([EXPIRY_HALT_REASON]));
});

/**
 * Type-level assertions. These run as ordinary code, but their value is that `bunx tsc` fails
 * if the inference stops matching the schema — which is the whole reason these types are
 * `z.infer` and not hand-written.
 */
test("the inferred types describe what the schemas actually produce", () => {
  // timestampSchema accepts a Date and emits an ISO string. Both sides of that are typed, and
  // conflating them is what breaks a server-side view that hands a Date straight to a response.
  const fromDate: Timestamp = timestampSchema.parse(new Date(0));
  const fromString: Timestamp = timestampSchema.parse("2026-09-05T00:00:00.000Z");
  const input: TimestampInput = new Date(0);
  expect(fromDate).toBe("1970-01-01T00:00:00.000Z");
  expect(fromString).toBe("2026-09-05T00:00:00.000Z");
  expect(timestampSchema.parse(input)).toBe(fromDate);

  const absent: NullableTimestamp = nullableTimestampSchema.parse(null);
  expect(absent).toBeNull();

  // addressSchema does not transform, so a parsed address is a plain string and `Address` says
  // so. hexAddressSchema does, and its output is narrower.
  const plain: Address = addressSchema.parse(`0x${"a".repeat(40)}`);
  const narrow: HexAddress = hexAddressSchema.parse(`0x${"A".repeat(40)}`);
  expect(plain).toBe(narrow.toLowerCase());

  // @ts-expect-error A plain string is not a `0x${string}`; the narrowing must be earned by
  // parsing through the transforming schema rather than asserted at a call site.
  const forged: HexAddress = plain;
  expect(forged as string).toBe(plain);

  const raw: RawUnits = rawUnitsSchema.parse("100");
  expect(raw).toBe("100");
  // No leading zeros: the worker compares this against units(...).toString() by exact equality
  // before it will execute, so "0100" is the same number but not the same authorization.
  expect(rawUnitsSchema.safeParse("0100").success).toBe(false);
});

test("the closed vocabularies are usable as exhaustive switch subjects", () => {
  // If a member is added to a schema and not to a disposition, these calls stop compiling —
  // which is the point. At runtime they simply must not throw or return undefined.
  const seen: string[] = [];
  for (const status of INSTANCE_STATUSES) seen.push(instanceDisposition(status));
  for (const status of EXECUTION_STATUSES) seen.push(executionDisposition(status));
  expect(seen).not.toContain(undefined);
  expect(seen).toHaveLength(INSTANCE_STATUSES.length + EXECUTION_STATUSES.length);
  const legs: TransactionLeg[] = [...TRANSACTION_LEGS];
  const instances: InstanceStatus[] = [...INSTANCE_STATUSES];
  expect(legs.length + instances.length).toBe(6);
});
