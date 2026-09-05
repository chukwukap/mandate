import { createHash } from "node:crypto";
import type { Envelope, Plan, Transition } from "../validation/schema.js";

/** A single expression longer than this is not something a person can meaningfully read. */
const MAX_EXPRESSION = 16_000;
/** A card longer than this is not a review; it is a wall the user scrolls past. */
const MAX_RENDER = 64_000;

export type ReviewCard = {
  /** What the signature actually authorises, in enforcement terms. */
  authority: string[];
  parameters: string[];
  /** One line per rule, in the order the engine consults them. */
  rules: string[];
  /**
   * Things that are true of this specific plan and would otherwise surprise the
   * signer. Empty for a plan none of them apply to.
   */
  cautions: string[];
};

export type Rendered = {
  card: ReviewCard;
  render_text: string;
  render_sha256: string;
};

/**
 * Render the card the user signs.
 *
 * Deterministic in the plan and the envelope and nothing else — no clock, no
 * locale, no iteration over an unordered container. `render_sha256` is folded into
 * the artifact id, so the same plan must render byte-for-byte identically on the API
 * that produced it and on the worker that verifies it hours later, on a different
 * process and a different machine.
 */
export function review(plan: Plan, envelope: Envelope): Rendered {
  const descriptions = describeNodes(plan);
  const c = envelope.caps;
  const card: ReviewCard = {
    authority: [
      `Buy spend: at most ${c.per_order} USDC per order, ${c.per_period} per ${c.period_secs} seconds, ${c.lifetime} over the lifetime.`,
      `Expires ${c.expires_at}; at most ${c.max_orders_per_period} orders per period; ${c.cooldown_secs}s cooldown per rule.`,
      `Assets: ${envelope.assets.map((a) => `${a.symbol} (${a.token})`).join(", ")}. Venue: Aerodrome. Slippage: ${c.slippage_bps} bps.`,
      "Onchain permissions enforce token, periodic allowance and expiry. Strategy conditions, per-order and lifetime limits are enforced by Mandate's server. Funds temporarily pass through its spender wallet.",
    ],
    parameters: plan.params.map((p) => `${p.label}: ${p.value}`),
    rules: plan.machines.flatMap((m) =>
      m.states.flatMap((s) =>
        s.transitions.map((t) => `${m.id}/${s.id}: ${describeRule(t, descriptions, envelope)}`),
      ),
    ),
    cautions: cautions(plan, envelope),
  };
  const render_text = [...card.authority, ...card.parameters, ...card.rules, ...card.cautions].join(
    "\n",
  );
  if (render_text.length > MAX_RENDER)
    throw new Error(`Strategy review exceeds ${MAX_RENDER} characters`);
  return {
    card,
    render_text,
    render_sha256: createHash("sha256").update(render_text).digest("hex"),
  };
}

/**
 * Expand every node into a self-contained expression.
 *
 * Nodes are already topologically ordered (validation refuses a forward reference),
 * so one pass suffices and no cycle can be reached. Expansion is intentional: the
 * user must be able to read the whole condition without cross-referencing node ids
 * they never wrote.
 */
function describeNodes(plan: Plan): Map<string, string> {
  const descriptions = new Map<string, string>();
  const params = new Map(plan.params.map((p) => [p.id, `${p.label} (${p.value})`]));
  for (const node of plan.nodes) {
    const args = node.args.map((a) =>
      a.kind === "const"
        ? a.value
        : a.kind === "feed"
          ? a.feed
          : a.kind === "param"
            ? params.get(a.param)
            : descriptions.get(a.node),
    );
    const description = `${node.op}(${args.join(", ")})`;
    // Nesting expands multiplicatively: a chain of 256 two-argument nodes each
    // reusing the previous one doubles the text every level. Cut it here, where the
    // failure is a rejected draft, rather than at the 64000-character card where the
    // user has already answered a compiler prompt.
    if (description.length > MAX_EXPRESSION)
      throw new Error("Strategy expression is too complex to review");
    descriptions.set(node.id, description);
  }
  return descriptions;
}

function describeRule(
  t: Transition,
  descriptions: ReadonlyMap<string, string>,
  envelope: Envelope,
): string {
  const firing =
    t.fires === "on_edge"
      ? "once on a rising edge"
      : `repeat at most ${t.max_repeats} times while true`;
  const actions = t.actions.map((a) => describeAction(a, descriptions, envelope)).join("; ");
  return `when ${descriptions.get(t.when)}, ${firing}: ${actions}; enter ${t.to}.`;
}

function describeAction(
  a: Transition["actions"][number],
  descriptions: ReadonlyMap<string, string>,
  envelope: Envelope,
): string {
  switch (a.action) {
    case "order": {
      const amount =
        a.size.unit === "quote" || a.size.unit === "base" ? a.size.value : `${a.size.bps} bps`;
      return `${a.side} ${amount} (${a.size.unit}) of ${envelope.assets[a.asset]?.symbol}`;
    }
    case "notify":
      return `notify: ${a.message}`;
    case "halt":
      return `halt: ${a.reason}`;
    case "set":
      // Validation rejects `set` before signing, so this is unreachable on any plan
      // that reaches a review card. Rendered as unsupported rather than as a working
      // assignment so it can never read to the signer as something that will happen.
      return `unsupported action: set ${a.var} = ${descriptions.get(a.value)}`;
  }
}

/**
 * Facts about this plan that the authority lines above do not convey and that the
 * signer would otherwise learn from a failed order.
 *
 * Each is computed from the plan, so it appears only where it applies, and each is
 * inside `render_text` — a caution the signature does not cover is decoration.
 */
function cautions(plan: Plan, envelope: Envelope): string[] {
  const out: string[] = [];
  const feeds = new Set<string>();
  let usesEquitySizing = false;
  let usesSell = false;
  for (const node of plan.nodes)
    for (const arg of node.args) if (arg.kind === "feed") feeds.add(arg.feed);
  for (const machine of plan.machines)
    for (const state of machine.states)
      for (const rule of state.transitions)
        for (const action of rule.actions) {
          if (action.action !== "order") continue;
          if (action.size.unit === "pct_equity") usesEquitySizing = true;
          if (action.side === "sell") usesSell = true;
        }

  // A pool address existing is not the same as a pool being priced. The same
  // AAPLc/USDC pair quotes $320.22 at tick spacing 10 and $37,861 at tick spacing
  // 200 — an 11,729% error — so a rule that decides on a pool price alone can be
  // walked into the wrong pool. Execution defends this by probing every tick spacing
  // and sanity-checking against Chainlink, but a *condition* that never reads the
  // oracle is deciding on the unverified number, and only the signer can accept that.
  const unhedged = [...feeds]
    .filter((f) => f.startsWith("dex:") && !feeds.has(`oracle:${f.slice(4)}`))
    .sort();
  if (unhedged.length > 0)
    out.push(
      `Caution: ${unhedged.join(", ")} ${unhedged.length === 1 ? "is a pool price" : "are pool prices"} used without the matching Chainlink oracle feed as a cross-check. Pool prices can be moved; a condition that reads one alone can fire on a price the oracle would not confirm.`,
    );

  if (usesEquitySizing)
    out.push(
      "Caution: percent-of-equity buys are sized against your USDC plus the value of your stock positions. Stock cannot be spent, so an order larger than your USDC balance will not settle.",
    );

  // routes.ts refuses to prepare a spend permission for any plan containing a sell
  // (409 sell-permission-required). Without this line the user signs a review, then
  // discovers at arming that half the strategy can never run automatically.
  if (usesSell)
    out.push(
      "Caution: this strategy contains sell rules. Automatic sell authority is not available, so sells are recorded as signals for you to act on; only buys can execute automatically.",
    );

  if (envelope.assets.length > 1)
    out.push(
      `Caution: rules address assets by position in the signed list (${envelope.assets.map((a, i) => `${i}=${a.symbol}`).join(", ")}). This list is part of what you are signing and cannot be reordered afterwards.`,
    );

  return out;
}
