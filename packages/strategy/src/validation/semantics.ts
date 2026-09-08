import { OPERATORS, operatorSignature } from "../evaluation/operators.js";
import type { Kind } from "../evaluation/types.js";
import { IssueLog, issuesFromZod, PlanInvalid } from "./issues.js";
import { type Asset, type Machine, type Plan, planSchema } from "./schema.js";

/**
 * Every feed URI the observed market can supply for a catalogue.
 *
 * The two price feeds per asset were the whole vocabulary, which meant a condition could see
 * what things cost but never what the user already owned. Sizing could — `pct_equity` and
 * `pct_position` have always been computed from exactly this portfolio — so the data was
 * present and simply unreadable from a rule. That asymmetry is what made target-weight
 * rebalancing inexpressible: you could say "buy 20% of equity" but not "buy only while Apple is
 * under 20% of equity", and the second is the one that defines the strategy.
 *
 * `position:` is a share count and `value:` is that count at the oracle price, because a rule
 * about portfolio weight needs money on both sides of the comparison.
 */
export function availableFeeds(assets: readonly Asset[]): Set<string> {
  return new Set([
    ...assets.flatMap((a) => [
      `dex:${a.symbol}`,
      `oracle:${a.symbol}`,
      `position:${a.symbol}`,
      `value:${a.symbol}`,
    ]),
    // Portfolio-wide, so not per asset. `equity` is cash plus the oracle value of every
    // allowlisted position; `cash` is the USDC that can actually be spent, which is the smaller
    // and more honest number for anything asking "can I afford this".
    "equity",
    "cash",
  ]);
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

/**
 * Schema plus semantics. Returns the parsed plan, or throws a `PlanInvalid`
 * carrying one issue per problem so the author sees everything that needs fixing.
 *
 * The plan is what the user signs, so anything accepted here is something Mandate
 * commits to executing. Rules that are merely inert (a machine that can never
 * transition, a `max_repeats` on a rule that ignores it) are rejected rather than
 * silently ignored: a signed strategy that provably cannot act is worse than an
 * error, because the user believes it is working.
 */
export function validatePlan(input: unknown, assets: readonly Asset[]): Plan {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) throw new PlanInvalid(issuesFromZod(parsed.error));
  const plan = parsed.data;

  const catalogue = new IssueLog();
  checkCatalogue(assets, catalogue);
  // Stop here on a broken catalogue: every feed and asset-index check below reads
  // from it, so continuing would report a cascade of misleading follow-on issues.
  catalogue.throwIfAny();

  const structure = new IssueLog();
  for (const id of duplicates(plan.params.map((p) => p.id)))
    structure.add("params", "duplicate-id", `Duplicate parameter: ${id}`);
  for (const id of duplicates(plan.nodes.map((n) => n.id)))
    structure.add("nodes", "duplicate-id", `Duplicate node: ${id}`);
  for (const id of duplicates(plan.machines.map((m) => m.id)))
    structure.add("machines", "duplicate-id", `Duplicate machine: ${id}`);
  // Identifier maps below assume uniqueness; a later duplicate would shadow an
  // earlier one and validate a different plan than the one that runs.
  structure.throwIfAny();

  const log = new IssueLog();
  const params = new Set(plan.params.map((p) => p.id));
  const feeds = availableFeeds(assets);
  const kinds = checkNodes(plan, params, feeds, log);
  for (const [index, machine] of plan.machines.entries())
    checkMachine(machine, `machines.${index}`, kinds, assets, log);
  log.throwIfAny();
  return plan;
}

function checkCatalogue(assets: readonly Asset[], log: IssueLog): void {
  if (assets.length === 0) {
    log.add("assets", "empty-catalogue", "A strategy needs at least one allowlisted asset.");
    return;
  }
  const symbols = new Set<string>();
  const tokens = new Set<string>();
  for (const [index, asset] of assets.entries()) {
    if (symbols.has(asset.symbol))
      log.add(
        `assets.${index}.symbol`,
        "duplicate-asset",
        `Duplicate asset symbol: ${asset.symbol}. Feeds are keyed by symbol, so the two entries would read the same price.`,
      );
    symbols.add(asset.symbol);
    const token = asset.token.toLowerCase();
    if (tokens.has(token))
      log.add(
        `assets.${index}.token`,
        "duplicate-asset",
        `Duplicate asset token: ${asset.token}. Positions are keyed by token, so the two entries would spend the same balance twice.`,
      );
    tokens.add(token);
  }
}

function checkNodes(
  plan: Plan,
  params: ReadonlySet<string>,
  feeds: ReadonlySet<string>,
  log: IssueLog,
): Map<string, Kind> {
  const kinds = new Map<string, Kind>();
  for (const [index, node] of plan.nodes.entries()) {
    const spec = OPERATORS[node.op];
    const path = `nodes.${index}`;
    if (node.args.length < spec.arity.min || node.args.length > spec.arity.max)
      log.add(
        `${path}.args`,
        "wrong-argument-count",
        `Wrong argument count for ${node.id}: ${operatorSignature(node.op)} (received ${node.args.length})`,
      );
    for (const [position, arg] of node.args.entries()) {
      const argPath = `${path}.args.${position}`;
      let kind: Kind = "number";
      if (arg.kind === "node") {
        const declared = kinds.get(arg.node);
        if (declared === undefined) {
          // Nodes evaluate top to bottom, so a reference to a later node — or to
          // itself — has no value when this node runs. Refusing it here is also
          // what makes cycles impossible without a separate cycle check.
          log.add(
            argPath,
            "unknown-node",
            `Unknown or forward node: ${arg.node}. A node may only use nodes declared above it.`,
          );
          continue;
        }
        kind = declared;
      } else if (arg.kind === "param" && !params.has(arg.param)) {
        log.add(argPath, "unknown-parameter", `Unknown parameter: ${arg.param}`);
        continue;
      } else if (arg.kind === "feed" && !feeds.has(arg.feed)) {
        log.add(
          argPath,
          "unknown-feed",
          `Unavailable feed: ${arg.feed}. Available feeds: ${[...feeds].sort().join(", ")}`,
        );
        continue;
      }
      if (kind !== spec.operands)
        log.add(
          argPath,
          "type-mismatch",
          `Type mismatch in ${node.id}: ${node.op} needs ${spec.operands === "number" ? "numbers" : "conditions"}, but argument ${position + 1} is a ${kind === "number" ? "number" : "condition"}`,
        );
    }
    // Record the declared result kind even when this node had an issue, so a later
    // node that uses it reports its own real problem instead of "unknown node".
    kinds.set(node.id, spec.result);
  }
  return kinds;
}

function checkMachine(
  machine: Machine,
  path: string,
  kinds: ReadonlyMap<string, Kind>,
  assets: readonly Asset[],
  log: IssueLog,
): void {
  // The Rust engine never instantiated position-scoped machines either. Refuse that
  // unsupported lifecycle explicitly instead of silently running it as a portfolio.
  if (machine.scope !== "portfolio")
    log.add(
      `${path}.scope`,
      "unsupported-scope",
      "Position-scoped machines are not supported; use a portfolio machine",
    );
  for (const id of duplicates(machine.states.map((s) => s.id)))
    log.add(`${path}.states`, "duplicate-id", `Duplicate state: ${id}`);
  const states = new Set(machine.states.map((s) => s.id));
  if (!states.has(machine.initial))
    log.add(`${path}.initial`, "unknown-state", `Unknown initial state: ${machine.initial}`);

  let transitions = 0;
  for (const [stateIndex, state] of machine.states.entries()) {
    for (const [index, rule] of state.transitions.entries()) {
      transitions++;
      const rulePath = `${path}.states.${stateIndex}.transitions.${index}`;
      if (!states.has(rule.to))
        log.add(`${rulePath}.to`, "unknown-state", `Unknown target state: ${rule.to}`);
      const guard = kinds.get(rule.when);
      if (guard === undefined)
        log.add(`${rulePath}.when`, "unknown-node", `Unknown condition node: ${rule.when}`);
      else if (guard !== "boolean")
        log.add(
          `${rulePath}.when`,
          "guard-not-condition",
          `Condition ${rule.when} produces a number; a rule needs a true/false node`,
        );
      if (rule.fires === "while_true" && rule.max_repeats === undefined)
        log.add(
          `${rulePath}.max_repeats`,
          "missing-limit",
          "Repeated firing requires a max_repeats limit",
        );
      // An on_edge rule fires once per false→true crossing and never consults
      // max_repeats. Accepting the field would let an author believe they capped a
      // rule that is in fact uncapped.
      if (rule.fires === "on_edge" && rule.max_repeats !== undefined)
        log.add(
          `${rulePath}.max_repeats`,
          "unused-limit",
          "max_repeats applies only to while_true rules; an on_edge rule already fires once per rising edge",
        );
      for (const [actionIndex, action] of rule.actions.entries()) {
        const actionPath = `${rulePath}.actions.${actionIndex}`;
        // `set` stores into machine variables that no argument kind can read back,
        // so the rule provably cannot influence any decision. Making variables
        // readable is worse: apps/worker/src/chain.ts re-checks an admitted order's
        // guard with evaluate(plan, feeds) alone — no machine, no variables — so a
        // readable variable would make that funding-time re-check disagree with the
        // tick that admitted the order and cancel valid orders.
        if (action.action === "set") {
          log.add(
            actionPath,
            "unsupported-action",
            "Stored variables are not supported: nothing can read them back, so this rule would have no effect",
          );
          continue;
        }
        if (action.action !== "order") continue;
        if (!assets[action.asset])
          log.add(
            `${actionPath}.asset`,
            "asset-outside-allowlist",
            `Asset ${action.asset} is outside the signed allowlist of ${assets.length} asset(s)`,
          );
        const allowed =
          action.side === "buy"
            ? (["quote", "pct_equity"] as const)
            : (["base", "pct_position"] as const);
        if (!allowed.some((unit) => unit === action.size.unit))
          log.add(
            `${actionPath}.size`,
            "size-unit-mismatch",
            `A ${action.side} is sized in ${allowed.join(" or ")}, not ${action.size.unit}`,
          );
      }
    }
  }
  if (transitions === 0)
    log.add(
      `${path}.states`,
      "inert-machine",
      `Machine ${machine.id} declares no transitions and can never act`,
    );
  else if (states.has(machine.initial)) unreachable(machine, path, log);
}

/**
 * States nothing can enter are dead weight in a signed artifact: the review card
 * describes rules that will never be consulted. Refuse rather than render them.
 */
function unreachable(machine: Machine, path: string, log: IssueLog): void {
  const byId = new Map(machine.states.map((s) => [s.id, s]));
  const reached = new Set<string>([machine.initial]);
  const queue = [machine.initial];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    if (id === undefined) continue;
    for (const rule of byId.get(id)?.transitions ?? [])
      if (!reached.has(rule.to) && byId.has(rule.to)) {
        reached.add(rule.to);
        queue.push(rule.to);
      }
  }
  for (const [index, state] of machine.states.entries())
    if (!reached.has(state.id))
      log.add(
        `${path}.states.${index}`,
        "unreachable-state",
        `State ${state.id} cannot be reached from ${machine.initial}`,
      );
}
