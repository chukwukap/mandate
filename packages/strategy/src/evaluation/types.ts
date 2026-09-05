import type { Decimal } from "decimal.js";
import type { OperatorId } from "./operators.js";

/** Every expression node is either a quantity or a condition. There is no third kind. */
export type Kind = "number" | "boolean";
export type Value = Decimal | boolean;

/** Observed market values, keyed `oracle:SYM` / `dex:SYM` (packages/evm/src/clients/base.ts). */
export type FeedValues = Readonly<Record<string, string>>;
export type NodeValues = ReadonlyMap<string, Value>;

export type EvaluableArg =
  | { readonly kind: "node"; readonly node: string }
  | { readonly kind: "param"; readonly param: string }
  | { readonly kind: "feed"; readonly feed: string }
  | { readonly kind: "const"; readonly value: string };
export type EvaluableNode = {
  readonly id: string;
  readonly op: OperatorId;
  readonly args: readonly EvaluableArg[];
};
/**
 * The evaluator's view of a plan. Declared structurally rather than importing the
 * validated `Plan` so that evaluation has no dependency on validation: validation
 * builds on the operator table here, not the other way round. A `Plan` is
 * assignable to this.
 */
export type EvaluablePlan = {
  readonly params: readonly { readonly id: string; readonly value: string }[];
  readonly nodes: readonly EvaluableNode[];
};
