import type { NodeValues } from "../evaluation/types.js";
import type { State, Transition } from "../validation/schema.js";
import type { MachineState } from "./runtime.js";

export type Selection = {
  readonly transition: Transition;
  readonly index: number;
  /** `<stateId>/<index>` — the key this rule's edge and repeat memory lives under. */
  readonly key: string;
};

/** The persisted memory this selection reads and advances. */
export type EdgeMemory = Pick<MachineState, "edges" | "repeats">;

/**
 * The edge-trigger core: record every rule's new truth value and pick at most one
 * rule to fire.
 *
 * This is the whole reason a strategy does not re-buy every tick. A guard like
 * "price below $200" stays true for hours; level-triggered evaluation would fire it
 * on every tick and drain the period cap in minutes. Only the transition fires:
 *
 * - `on_edge` fires on a false→true crossing and stays silent while the guard
 *   remains true. It fires again only after the guard has gone false and back.
 * - `while_true` fires on each tick the guard holds, up to `max_repeats`, and its
 *   counter resets the moment the guard goes false — so the limit bounds one
 *   episode, not the strategy's lifetime.
 *
 * Two details that look incidental and are not:
 *
 * 1. Every rule's edge is recorded, including rules after the one that fired.
 *    Skipping them would leave a stale `false` behind, and the losing rule would
 *    fire spuriously on a later tick as though its guard had just risen — a second
 *    order from a condition that never actually crossed.
 * 2. At most one rule fires per machine per tick, because firing moves the machine
 *    to `transition.to`; later rules belong to the state it just left. Declaration
 *    order is the priority order, and the review card renders it in that order so
 *    the user sees which rule wins.
 *
 * Mutates `memory` and returns the selection; the caller applies the actions.
 */
export function selectTransition(
  state: State,
  memory: EdgeMemory,
  values: NodeValues,
): Selection | undefined {
  let chosen: Selection | undefined;
  for (const [index, transition] of state.transitions.entries()) {
    const key = `${state.id}/${index}`;
    // A guard that is missing, or that somehow evaluated to a number, reads as
    // false. Validation guarantees neither can happen on a signed plan; if one did,
    // not acting is the safe reading.
    const truth = values.get(transition.when) === true;
    const previous = memory.edges[key] ?? false;
    memory.edges[key] = truth;
    if (!truth) {
      memory.repeats[key] = 0;
      continue;
    }
    if (chosen) continue;
    const repeats = memory.repeats[key] ?? 0;
    const eligible =
      transition.fires === "on_edge" ? !previous : repeats < (transition.max_repeats ?? 0);
    if (!eligible) continue;
    chosen = { transition, index, key };
    if (transition.fires === "while_true") memory.repeats[key] = repeats + 1;
  }
  return chosen;
}
