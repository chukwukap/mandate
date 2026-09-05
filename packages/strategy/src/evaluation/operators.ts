import type { Decimal } from "decimal.js";
import { Money } from "./money.js";
import type { Kind, Value } from "./types.js";

export const OPERATOR_IDS = [
  "add",
  "sub",
  "mul",
  "safe_div",
  "abs",
  "min",
  "max",
  "gt",
  "gte",
  "lt",
  "lte",
  "eq",
  "and",
  "or",
  "not",
] as const;
export type OperatorId = (typeof OPERATOR_IDS)[number];

/** Widest argument list the plan schema permits (`z.array(arg).min(1).max(32)`). */
const VARIADIC_MAX = 32;

type Arity = { readonly min: number; readonly max: number };
type NumericOperator = {
  readonly operands: "number";
  readonly result: Kind;
  readonly arity: Arity;
  readonly apply: (args: readonly Decimal[]) => Value;
};
type LogicalOperator = {
  readonly operands: "boolean";
  readonly result: "boolean";
  readonly arity: Arity;
  readonly apply: (args: readonly boolean[]) => boolean;
};
export type Operator = NumericOperator | LogicalOperator;

// Arity and operand kinds live here once. They used to be written twice — a hand
// rolled `exact = op === "safe_div" ? 3 : ...` ladder in the validator and an
// independent switch in the evaluator — so a new operator, or a changed arity,
// could be accepted by validation and then throw at tick time on a signed
// strategy. One table means the two cannot disagree.
function at<T>(args: readonly T[], index: number): T {
  const value = args[index];
  if (value === undefined) throw new Error("Operator applied with too few arguments");
  return value;
}
const compare = (
  apply: (a: Decimal, b: Decimal) => boolean,
): NumericOperator & { result: "boolean" } => ({
  operands: "number",
  result: "boolean",
  arity: { min: 2, max: 2 },
  apply: (args) => apply(at(args, 0), at(args, 1)),
});

export const OPERATORS: { readonly [K in OperatorId]: Operator } = {
  add: {
    operands: "number",
    result: "number",
    arity: { min: 2, max: VARIADIC_MAX },
    apply: (args) => args.reduce<Decimal>((sum, v) => sum.plus(v), new Money(0)),
  },
  sub: {
    operands: "number",
    result: "number",
    arity: { min: 2, max: VARIADIC_MAX },
    // Left-associative: sub(a, b, c) is a - b - c, not a - (b - c).
    apply: (args) => args.slice(1).reduce<Decimal>((acc, v) => acc.minus(v), at(args, 0)),
  },
  mul: {
    operands: "number",
    result: "number",
    arity: { min: 2, max: VARIADIC_MAX },
    apply: (args) => args.reduce<Decimal>((product, v) => product.mul(v), new Money(1)),
  },
  safe_div: {
    operands: "number",
    result: "number",
    arity: { min: 3, max: 3 },
    // safe_div(a, b, fallback). A strategy divides by a live observation; a zero
    // divisor is a market state, not a bug, and must not abort the whole tick and
    // leave the position unmanaged. The author names the value to use instead.
    apply: (args) => (at(args, 1).isZero() ? at(args, 2) : at(args, 0).div(at(args, 1))),
  },
  abs: {
    operands: "number",
    result: "number",
    arity: { min: 1, max: 1 },
    apply: (args) => at(args, 0).abs(),
  },
  min: {
    operands: "number",
    result: "number",
    arity: { min: 2, max: VARIADIC_MAX },
    apply: (args) => Money.min(...args),
  },
  max: {
    operands: "number",
    result: "number",
    arity: { min: 2, max: VARIADIC_MAX },
    apply: (args) => Money.max(...args),
  },
  gt: compare((a, b) => a.gt(b)),
  gte: compare((a, b) => a.gte(b)),
  lt: compare((a, b) => a.lt(b)),
  lte: compare((a, b) => a.lte(b)),
  eq: compare((a, b) => a.eq(b)),
  and: {
    operands: "boolean",
    result: "boolean",
    arity: { min: 2, max: VARIADIC_MAX },
    apply: (args) => args.every((v) => v),
  },
  or: {
    operands: "boolean",
    result: "boolean",
    arity: { min: 2, max: VARIADIC_MAX },
    apply: (args) => args.some((v) => v),
  },
  not: {
    operands: "boolean",
    result: "boolean",
    arity: { min: 1, max: 1 },
    apply: (args) => !at(args, 0),
  },
};

/** Human-readable arity, for a validation message the author can act on. */
export function operatorSignature(op: OperatorId): string {
  const { arity, operands } = OPERATORS[op];
  const count =
    arity.min === arity.max
      ? `exactly ${arity.min} argument${arity.min === 1 ? "" : "s"}`
      : `between ${arity.min} and ${arity.max} arguments`;
  return `${op} takes ${count}, each a ${operands === "number" ? "number" : "condition"}`;
}
