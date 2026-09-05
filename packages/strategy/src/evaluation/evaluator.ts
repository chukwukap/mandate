import type { Decimal } from "decimal.js";
import { isDecimalString, isFeedValue, Money } from "./money.js";
import { OPERATORS, operatorSignature } from "./operators.js";
import type { EvaluableNode, EvaluablePlan, FeedValues, Value } from "./types.js";

/**
 * Beyond this magnitude a result stops being a plausible price, quantity or ratio
 * and is almost certainly a runaway `mul`. Rejecting it turns an arithmetic blow-up
 * into a skipped tick instead of a comparison against a number nobody intended.
 */
const MAX_MAGNITUDE = "1e60";

function label(value: string): string {
  return value.length > 32 ? `${value.slice(0, 32)}…` : value;
}

/**
 * Evaluate every node in declaration order against live inputs.
 *
 * Throws rather than returning partial results. A missing or unusable input means
 * the strategy's view of the market is incomplete, and the only safe outcome is to
 * skip the tick: silently treating a broken price as "condition not met" would let
 * a stop-loss sit quiet exactly when its feed breaks.
 */
export function evaluate(plan: EvaluablePlan, feeds: FeedValues): Map<string, Value> {
  const out = new Map<string, Value>();
  const params = new Map<string, Decimal>();
  for (const param of plan.params) {
    if (!isDecimalString(param.value))
      throw new Error(`Parameter ${param.id} is not a decimal number`);
    params.set(param.id, new Money(param.value));
  }
  for (const node of plan.nodes) {
    const operands = node.args.map((arg) => resolve(node, arg, out, params, feeds));
    const spec = OPERATORS[node.op];
    if (operands.length < spec.arity.min || operands.length > spec.arity.max)
      throw new Error(`Node ${node.id}: ${operatorSignature(node.op)}`);
    let result: Value;
    if (spec.operands === "number") {
      const numeric: Decimal[] = [];
      // Check every operand before applying. `and`/`or` short-circuit, so a lazy
      // check would let a type error in a later argument through undetected on the
      // ticks where the first argument already decided the answer.
      for (const [index, value] of operands.entries()) {
        if (typeof value === "boolean")
          throw new Error(`Node ${node.id}: argument ${index + 1} is a condition, not a number`);
        numeric.push(value);
      }
      result = spec.apply(numeric);
    } else {
      const logical: boolean[] = [];
      for (const [index, value] of operands.entries()) {
        if (typeof value !== "boolean")
          throw new Error(`Node ${node.id}: argument ${index + 1} is a number, not a condition`);
        logical.push(value);
      }
      result = spec.apply(logical);
    }
    if (typeof result !== "boolean" && (!result.isFinite() || result.abs().gte(MAX_MAGNITUDE)))
      throw new Error(`Node ${node.id}: arithmetic overflow`);
    out.set(node.id, result);
  }
  return out;
}

function resolve(
  node: EvaluableNode,
  arg: EvaluableNode["args"][number],
  out: ReadonlyMap<string, Value>,
  params: ReadonlyMap<string, Decimal>,
  feeds: FeedValues,
): Value {
  switch (arg.kind) {
    case "const":
      if (!isDecimalString(arg.value))
        throw new Error(`Node ${node.id}: constant is not a decimal number`);
      return new Money(arg.value);
    case "param": {
      const value = params.get(arg.param);
      if (value === undefined) throw new Error(`Node ${node.id}: unknown parameter ${arg.param}`);
      return value;
    }
    case "node": {
      const value = out.get(arg.node);
      if (value === undefined)
        throw new Error(`Node ${node.id}: unknown or forward node ${arg.node}`);
      return value;
    }
    case "feed": {
      const raw = feeds[arg.feed];
      if (raw === undefined) throw new Error(`Node ${node.id}: missing observation ${arg.feed}`);
      // decimal.js is far more permissive than a price feed should be, in two ways
      // that both end in a wrong decision rather than an error:
      //
      //   new Money("NaN")      -> NaN, and every comparison against NaN is false,
      //                            so a stop-loss reads "not triggered" on a price
      //                            it never saw. The finite check below never
      //                            catches it, because a comparison yields a boolean.
      //   new Money("Infinity") -> Infinity, which passes every "above" test.
      //   new Money("0x10")     -> 16. Hex, octal, binary and "1_0" separators are
      //                            all accepted and silently reinterpreted.
      //
      // Anything else ("", "null", "abc") throws a bare DecimalError naming only the
      // string, with no indication of which feed or node produced it. Checking the
      // shape first turns all of it into one message that names both.
      if (!isFeedValue(raw))
        throw new Error(`Node ${node.id}: unusable value for ${arg.feed} (${label(raw)})`);
      return new Money(raw);
    }
  }
}
