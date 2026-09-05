import { expect, test } from "bun:test";
import type { Decimal } from "decimal.js";
import {
  type EvaluablePlan,
  evaluate,
  isDecimalString,
  isFeedValue,
  Money,
  OPERATORS,
  units,
  whole,
} from "../src/evaluation/index.js";

type Arg = EvaluablePlan["nodes"][number]["args"][number];
const konst = (value: string): Arg => ({ kind: "const", value });
const feed = (uri: string): Arg => ({ kind: "feed", feed: uri });
const ref = (node: string): Arg => ({ kind: "node", node });

function plan(nodes: EvaluablePlan["nodes"], params: EvaluablePlan["params"] = []): EvaluablePlan {
  return { params, nodes };
}
function number(values: Map<string, unknown>, id: string): string {
  const value = values.get(id);
  if (value === undefined || typeof value === "boolean") throw new Error(`${id} is not a number`);
  return (value as Decimal).toFixed();
}

test("safe_div returns the authored fallback instead of aborting on a zero divisor", () => {
  const values = evaluate(
    plan([
      { id: "ratio", op: "safe_div", args: [konst("7"), feed("dex:AAPLc"), konst("-1")] },
      { id: "flagged", op: "lt", args: [ref("ratio"), konst("0")] },
    ]),
    { "dex:AAPLc": "0" },
  );
  // A zero divisor is a market state, not a bug: the whole tick must not die and
  // leave a funded position unmanaged.
  expect(number(values, "ratio")).toBe("-1");
  expect(values.get("flagged")).toBe(true);
  expect(
    number(
      evaluate(
        plan([{ id: "r", op: "safe_div", args: [konst("7"), konst("2"), konst("-1")] }]),
        {},
      ),
      "r",
    ),
  ).toBe("3.5");
});

test("argument order is fixed for the non-commutative operators", () => {
  const values = evaluate(
    plan([
      { id: "d", op: "sub", args: [konst("10"), konst("3"), konst("2")] },
      { id: "lo", op: "min", args: [konst("5"), konst("-2"), konst("9")] },
      { id: "hi", op: "max", args: [konst("5"), konst("-2"), konst("9")] },
      { id: "cmp", op: "lt", args: [konst("1"), konst("2")] },
      { id: "cmp2", op: "lt", args: [konst("2"), konst("1")] },
    ]),
    {},
  );
  // Left-associative: 10 - 3 - 2, never 10 - (3 - 2).
  expect(number(values, "d")).toBe("5");
  expect(number(values, "lo")).toBe("-2");
  expect(number(values, "hi")).toBe("9");
  expect(values.get("cmp")).toBe(true);
  expect(values.get("cmp2")).toBe(false);
});

test("a runaway product is rejected rather than compared as an implausible price", () => {
  const huge = `1${"0".repeat(39)}`;
  expect(() =>
    evaluate(plan([{ id: "boom", op: "mul", args: [konst(huge), konst(huge)] }]), {}),
  ).toThrow("arithmetic overflow");
  // Just under the guard still evaluates: the limit rejects blow-ups, not big numbers.
  const ok = evaluate(
    plan([
      { id: "big", op: "mul", args: [konst(`1${"0".repeat(30)}`), konst(`1${"0".repeat(29)}`)] },
    ]),
    {},
  );
  expect(number(ok, "big")).toBe(`1${"0".repeat(59)}`);
});

test("arithmetic is exact where binary floating point drifts", () => {
  const values = evaluate(
    plan([
      { id: "sum", op: "add", args: [konst("0.1"), konst("0.2")] },
      { id: "same", op: "eq", args: [ref("sum"), konst("0.3")] },
      { id: "nav", op: "sub", args: [feed("dex:AAPLc"), feed("oracle:AAPLc")] },
    ]),
    { "dex:AAPLc": "320.22", "oracle:AAPLc": "320.08" },
  );
  expect(number(values, "sum")).toBe("0.3");
  // 0.1 + 0.2 === 0.3 is false in float; a "within 0.3 of NAV" rule would misfire.
  expect(0.1 + 0.2 === 0.3).toBe(false);
  expect(values.get("same")).toBe(true);
  expect(number(values, "nav")).toBe("0.14");
});

test("a broken feed throws instead of quietly reading as 'condition not met'", () => {
  const stop = plan([{ id: "below", op: "lt", args: [feed("oracle:AAPLc"), konst("200")] }]);

  // These four are the dangerous ones: decimal.js accepts them and produces a
  // number, so without the shape guard the strategy decides on a price nobody
  // published. "NaN" makes every comparison false (a stop-loss sleeps exactly when
  // its feed breaks); "Infinity" passes every "above" test; "0x10" and "1_0" are
  // silently reinterpreted as 16 and 10.
  expect(new Money("NaN").isNaN()).toBe(true);
  expect(new Money("Infinity").isFinite()).toBe(false);
  expect(new Money("0x10").toFixed()).toBe("16");
  expect(new Money("1_0").toFixed()).toBe("10");
  for (const misread of ["NaN", "Infinity", "-Infinity", "0x10", "1_0", "1e5"])
    expect(() => evaluate(stop, { "oracle:AAPLc": misread })).toThrow("unusable value");

  // These throw inside decimal.js anyway, but as a bare "Invalid argument: null"
  // that names neither the feed nor the node. The guard names both.
  for (const rejected of ["", "null", "abc", "1,000", " 1 "]) {
    expect(() => new Money(rejected)).toThrow();
    expect(() => evaluate(stop, { "oracle:AAPLc": rejected })).toThrow("oracle:AAPLc");
  }

  expect(() => evaluate(stop, {})).toThrow("missing observation");
  expect(evaluate(stop, { "oracle:AAPLc": "150" }).get("below")).toBe(true);
});

test("a live quote carries more precision than an authored constant, and is still accepted", () => {
  // packages/evm derives dex:SYM as 10 / amount_out, which prints ~75 fraction
  // digits at precision 78. Holding a feed to the authored 28-digit limit would
  // reject a perfectly good price.
  const live = `320.22${"0".repeat(60)}17`;
  expect(isDecimalString(live)).toBe(false);
  expect(isFeedValue(live)).toBe(true);
  const values = evaluate(
    plan([{ id: "over", op: "gt", args: [feed("dex:AAPLc"), konst("320.22")] }]),
    { "dex:AAPLc": live },
  );
  expect(values.get("over")).toBe(true);
});

test("forward and unknown references throw before any operator runs", () => {
  expect(() => evaluate(plan([{ id: "a", op: "not", args: [ref("later")] }]), {})).toThrow(
    "unknown or forward node later",
  );
  expect(() =>
    evaluate(plan([{ id: "a", op: "add", args: [{ kind: "param", param: "k" }, konst("1")] }]), {}),
  ).toThrow("unknown parameter k");
  expect(() =>
    evaluate(
      plan([{ id: "a", op: "add", args: [konst("1"), konst("2")] }], [{ id: "k", value: "oops" }]),
      {},
    ),
  ).toThrow("not a decimal number");
});

test("every operand is type-checked even when a logical operator would short-circuit", () => {
  const values = evaluate(
    plan([
      { id: "yes", op: "lt", args: [konst("1"), konst("2")] },
      { id: "no", op: "not", args: [ref("yes")] },
    ]),
    {},
  );
  expect(values.get("no")).toBe(false);
  // `or` is satisfied by its first argument; a lazy check would let the second
  // argument's type error through on exactly the ticks where the first is true.
  expect(() =>
    evaluate(
      plan([
        { id: "yes", op: "lt", args: [konst("1"), konst("2")] },
        { id: "bad", op: "or", args: [ref("yes"), konst("5")] },
      ]),
      {},
    ),
  ).toThrow("argument 2 is a number, not a condition");
  expect(() =>
    evaluate(
      plan([
        { id: "yes", op: "lt", args: [konst("1"), konst("2")] },
        { id: "bad", op: "add", args: [ref("yes"), konst("1")] },
      ]),
      {},
    ),
  ).toThrow("argument 1 is a condition, not a number");
});

test("the operator table bounds arity at evaluation as well as at validation", () => {
  expect(OPERATORS.safe_div.arity).toEqual({ min: 3, max: 3 });
  expect(OPERATORS.not.arity).toEqual({ min: 1, max: 1 });
  expect(() =>
    evaluate(plan([{ id: "a", op: "safe_div", args: [konst("1"), konst("2")] }]), {}),
  ).toThrow("exactly 3 arguments");
});

test("token amounts floor at the token's real decimals, not at eighteen", () => {
  // AAPLc has 8 decimals. Treating it as 18 would inflate an order 10^10 times.
  expect(units("1.234567891", 8)).toBe(123456789n);
  expect(whole(123456789n, 8)).toBe("1.23456789");
  expect(units("9007199254740993.123456", 6)).toBe(9007199254740993123456n);
  expect(units("0.000000005", 8)).toBe(0n);
  expect(() => units("-1", 6)).toThrow("Invalid token quantity");
  expect(() => units(`1${"0".repeat(60)}`, 18)).toThrow("Token quantity overflow");
});
