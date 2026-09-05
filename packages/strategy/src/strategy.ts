import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { z } from "zod";

// Decimal prices and integer token units never pass through binary floating point.
export const Money = Decimal.clone({ precision: 78, rounding: Decimal.ROUND_DOWN });
const decimal = z.string().regex(/^-?\d{1,40}(\.\d{1,28})?$/);
const positive = decimal.refine((v) => new Money(v).gt(0), "Must be positive");
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const arg = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("node"), node: id }),
  z.strictObject({ kind: z.literal("param"), param: id }),
  z.strictObject({ kind: z.literal("feed"), feed: z.string().min(1).max(120) }),
  z.strictObject({ kind: z.literal("const"), value: decimal }),
]);
const size = z.discriminatedUnion("unit", [
  z.strictObject({ unit: z.literal("quote"), value: positive }),
  z.strictObject({ unit: z.literal("base"), value: positive }),
  z.strictObject({ unit: z.literal("pct_equity"), bps: z.int().min(1).max(10_000) }),
  z.strictObject({ unit: z.literal("pct_position"), bps: z.int().min(1).max(10_000) }),
]);
export const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("order"),
    asset: z.int().nonnegative(),
    side: z.enum(["buy", "sell"]),
    size,
  }),
  z.strictObject({ action: z.literal("set"), var: id, value: id }),
  z.strictObject({ action: z.literal("notify"), message: z.string().min(1).max(500) }),
  z.strictObject({ action: z.literal("halt"), reason: z.string().min(1).max(500) }),
]);
const transition = z.strictObject({
  when: id,
  fires: z.enum(["on_edge", "while_true"]).default("on_edge"),
  max_repeats: z.int().min(1).max(10_000).optional(),
  actions: z.array(actionSchema).min(1).max(16),
  to: id,
});
export const planSchema = z.strictObject({
  params: z
    .array(z.strictObject({ id, label: z.string().max(120), value: decimal }))
    .max(64)
    .default([]),
  nodes: z
    .array(
      z.strictObject({
        id,
        op: z.enum([
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
        ]),
        args: z.array(arg).min(1).max(32),
      }),
    )
    .min(1)
    .max(256),
  machines: z
    .array(
      z.strictObject({
        id,
        scope: z.enum(["portfolio", "position"]),
        initial: id,
        states: z
          .array(z.strictObject({ id, transitions: z.array(transition).max(32) }))
          .min(1)
          .max(32),
      }),
    )
    .min(1)
    .max(16),
});
export const capsSchema = z
  .strictObject({
    lifetime: positive,
    per_order: positive,
    per_period: positive,
    period_secs: z.int().min(1).max(31_536_000),
    max_orders_per_period: z.int().min(1).max(10_000),
    cooldown_secs: z.int().min(0).max(31_536_000),
    expires_at: z.iso.datetime({ offset: true }),
    slippage_bps: z.int().min(1).max(500).default(50),
  })
  .superRefine((c, ctx) => {
    if (new Money(c.per_order).gt(c.per_period) || new Money(c.per_period).gt(c.lifetime)) {
      ctx.addIssue({ code: "custom", message: "Require per-order ≤ per-period ≤ lifetime" });
    }
    for (const field of ["lifetime", "per_order", "per_period"] as const) {
      if (new Money(c[field]).decimalPlaces() > 6)
        ctx.addIssue({ code: "custom", path: [field], message: "USDC has six decimal places" });
      if (units(c[field], 6) >= 2n ** 160n)
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "Exceeds onchain allowance capacity",
        });
    }
  });
export type Plan = z.infer<typeof planSchema>;
export type Caps = z.infer<typeof capsSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Asset = { symbol: string; token: `0x${string}`; feed: `0x${string}`; decimals: number };
export type Envelope = {
  version: "mandate/2";
  caps: Caps;
  assets: Asset[];
  quote: `0x${string}`;
  venue: "aerodrome";
};
type Kind = "number" | "boolean";
type Value = Decimal | boolean;

export function units(value: string, decimals: number): bigint {
  const v = new Money(value);
  if (!v.isFinite() || v.isNegative()) throw new Error("Invalid token quantity");
  const raw = v.mul(new Money(10).pow(decimals)).floor();
  if (raw.gte(new Money(2).pow(256))) throw new Error("Token quantity overflow");
  return BigInt(raw.toFixed(0));
}
export function whole(value: bigint, decimals: number): string {
  return new Money(value.toString()).div(new Money(10).pow(decimals)).toFixed();
}
function unique(names: string[], label: string) {
  if (new Set(names).size !== names.length) throw new Error(`Duplicate ${label}`);
}
export function validatePlan(input: unknown, assets: Asset[]): Plan {
  const plan = planSchema.parse(input);
  unique(
    plan.params.map((p) => p.id),
    "parameter",
  );
  unique(
    plan.nodes.map((n) => n.id),
    "node",
  );
  unique(
    plan.machines.map((m) => m.id),
    "machine",
  );
  const params = new Set(plan.params.map((p) => p.id));
  const feeds = new Set(assets.flatMap((a) => [`dex:${a.symbol}`, `oracle:${a.symbol}`]));
  const kinds = new Map<string, Kind>();
  for (const node of plan.nodes) {
    const inputKinds = node.args.map((a): Kind => {
      if (a.kind === "node") {
        const kind = kinds.get(a.node);
        if (!kind) throw new Error(`Unknown or forward node: ${a.node}`);
        return kind;
      }
      if (a.kind === "param" && !params.has(a.param))
        throw new Error(`Unknown parameter: ${a.param}`);
      if (a.kind === "feed" && !feeds.has(a.feed)) throw new Error(`Unavailable feed: ${a.feed}`);
      return "number";
    });
    const logical = ["and", "or", "not"].includes(node.op);
    const comparison = ["lt", "lte", "gt", "gte", "eq"].includes(node.op);
    const exact =
      node.op === "safe_div"
        ? 3
        : ["abs", "not"].includes(node.op)
          ? 1
          : comparison
            ? 2
            : undefined;
    if (exact !== undefined ? node.args.length !== exact : node.args.length < 2)
      throw new Error(`Wrong argument count: ${node.id}`);
    if (inputKinds.some((k) => k !== (logical ? "boolean" : "number")))
      throw new Error(`Type mismatch: ${node.id}`);
    kinds.set(node.id, logical || comparison ? "boolean" : "number");
  }
  for (const machine of plan.machines) {
    // The Rust engine also never instantiated position-scoped machines. Refuse that
    // unsupported lifecycle explicitly instead of silently running it as a portfolio.
    if (machine.scope !== "portfolio")
      throw new Error("Position-scoped machines are not supported; use a portfolio machine");
    unique(
      machine.states.map((s) => s.id),
      "state",
    );
    const states = new Set(machine.states.map((s) => s.id));
    if (!states.has(machine.initial)) throw new Error("Unknown initial state");
    for (const state of machine.states)
      for (const t of state.transitions) {
        if (!states.has(t.to) || kinds.get(t.when) !== "boolean")
          throw new Error("Invalid transition target or guard");
        if (t.fires === "while_true" && t.max_repeats === undefined)
          throw new Error("Repeated firing requires a limit");
        for (const action of t.actions) {
          if (action.action === "set" && kinds.get(action.value) !== "number")
            throw new Error("Set requires a numeric node");
          if (action.action === "order") {
            if (!assets[action.asset]) throw new Error("Asset outside allowlist");
            const allowed =
              action.side === "buy" ? ["quote", "pct_equity"] : ["base", "pct_position"];
            if (!allowed.includes(action.size.unit))
              throw new Error("Order side and size unit disagree");
          }
        }
      }
  }
  return plan;
}
export function evaluate(plan: Plan, feeds: Record<string, string>): Map<string, Value> {
  const out = new Map<string, Value>();
  const params = new Map(plan.params.map((p) => [p.id, new Money(p.value)]));
  for (const node of plan.nodes) {
    const args = node.args.map((arg): Value => {
      if (arg.kind === "const") return new Money(arg.value);
      const v =
        arg.kind === "node"
          ? out.get(arg.node)
          : arg.kind === "param"
            ? params.get(arg.param)
            : feeds[arg.feed];
      if (v === undefined) throw new Error(`Missing input for ${node.id}`);
      return typeof v === "string" ? new Money(v) : v;
    });
    const num = (i: number): Decimal => {
      const a = args[i];
      if (a === undefined || typeof a === "boolean") throw new Error("Expected number");
      return a;
    };
    const bool = (i: number): boolean => {
      const a = args[i];
      if (typeof a !== "boolean") throw new Error("Expected boolean");
      return a;
    };
    let result: Value;
    switch (node.op) {
      case "add":
        result = args.reduce<Decimal>((a, _, i) => a.plus(num(i)), new Money(0));
        break;
      case "sub":
        result = args.slice(1).reduce<Decimal>((a, _, i) => a.minus(num(i + 1)), num(0));
        break;
      case "mul":
        result = args.reduce<Decimal>((a, _, i) => a.mul(num(i)), new Money(1));
        break;
      case "safe_div":
        result = num(1).isZero() ? num(2) : num(0).div(num(1));
        break;
      case "abs":
        result = num(0).abs();
        break;
      case "min":
        result = Money.min(...args.map((_, i) => num(i)));
        break;
      case "max":
        result = Money.max(...args.map((_, i) => num(i)));
        break;
      case "lt":
        result = num(0).lt(num(1));
        break;
      case "lte":
        result = num(0).lte(num(1));
        break;
      case "gt":
        result = num(0).gt(num(1));
        break;
      case "gte":
        result = num(0).gte(num(1));
        break;
      case "eq":
        result = num(0).eq(num(1));
        break;
      case "and":
        result = args.every((_, i) => bool(i));
        break;
      case "or":
        result = args.some((_, i) => bool(i));
        break;
      case "not":
        result = !bool(0);
        break;
    }
    if (typeof result !== "boolean" && (!result.isFinite() || result.abs().gte("1e60")))
      throw new Error("Arithmetic overflow");
    out.set(node.id, result);
  }
  return out;
}

export type MachineState = {
  current: string;
  vars: Record<string, string>;
  edges: Record<string, boolean>;
  repeats: Record<string, number>;
};
export type Runtime = {
  machines: Record<string, MachineState>;
  lifetime: string;
  periodSpent: string;
  periodStart: number;
  orders: number;
  totalOrders: number;
  lastFires: Record<string, number>;
  halted: boolean;
};
export type Portfolio = { equity: string; positions: Record<string, string> };
export type Intent = { asset: number; side: "buy" | "sell"; amount: string; fireKey: string };
export function initialRuntime(plan: Plan, now: number): Runtime {
  return {
    machines: Object.fromEntries(
      plan.machines.map((m) => [m.id, { current: m.initial, vars: {}, edges: {}, repeats: {} }]),
    ),
    lifetime: "0",
    periodSpent: "0",
    periodStart: now,
    orders: 0,
    totalOrders: 0,
    lastFires: {},
    halted: false,
  };
}
export function tick(
  plan: Plan,
  envelope: Envelope,
  previous: Runtime,
  feeds: Record<string, string>,
  portfolio: Portfolio,
  now: number,
) {
  const state = structuredClone(previous);
  const result = {
    state,
    intents: [] as Intent[],
    refused: [] as string[],
    notifications: [] as string[],
  };
  if (state.halted) return result;
  if (now >= Date.parse(envelope.caps.expires_at)) {
    state.halted = true;
    result.refused.push("Strategy expired");
    return result;
  }
  const values = evaluate(plan, feeds); // No partial tick when an input is missing.
  const remainingPositions = { ...portfolio.positions };
  const caps = envelope.caps;
  if (now - state.periodStart >= caps.period_secs * 1000) {
    state.periodStart +=
      Math.floor((now - state.periodStart) / (caps.period_secs * 1000)) * caps.period_secs * 1000;
    state.periodSpent = "0";
    state.orders = 0;
  }
  for (const machine of plan.machines) {
    const ms = state.machines[machine.id];
    if (!ms) throw new Error("Missing persisted machine");
    const current = machine.states.find((s) => s.id === ms.current);
    if (!current) throw new Error("Invalid persisted state");
    let chosen:
      | { t: Plan["machines"][number]["states"][number]["transitions"][number]; key: string }
      | undefined;
    current.transitions.forEach((t, i) => {
      const key = `${current.id}/${i}`;
      const truth = values.get(t.when) === true;
      const prior = ms.edges[key] ?? false;
      ms.edges[key] = truth;
      if (!truth) {
        ms.repeats[key] = 0;
        return;
      }
      if (chosen) return;
      if (t.fires === "on_edge" ? !prior : (ms.repeats[key] ?? 0) < (t.max_repeats ?? 0)) {
        chosen = { t, key: `${machine.id}/${key}` };
        if (t.fires === "while_true") ms.repeats[key] = (ms.repeats[key] ?? 0) + 1;
      }
    });
    if (!chosen) continue;
    ms.current = chosen.t.to;
    const previousFire = state.lastFires[chosen.key] ?? -Infinity;
    for (const action of chosen.t.actions) {
      if (action.action === "halt") {
        state.halted = true;
        result.notifications.push(action.reason);
        break;
      }
      if (action.action === "notify") {
        result.notifications.push(action.message);
        continue;
      }
      if (action.action === "set") {
        const v = values.get(action.value);
        if (v && typeof v !== "boolean") ms.vars[action.var] = v.toFixed();
        continue;
      }
      const asset = envelope.assets[action.asset];
      if (!asset) throw new Error("Unknown asset");
      const s = action.size;
      const amount =
        s.unit === "quote" || s.unit === "base"
          ? s.value
          : new Money(
              s.unit === "pct_equity"
                ? portfolio.equity
                : (portfolio.positions[asset.token.toLowerCase()] ?? "0"),
            )
              .mul(s.bps)
              .div(10_000)
              .toFixed();
      const raw = units(amount, action.side === "buy" ? 6 : asset.decimals);
      const exact = whole(raw, action.side === "buy" ? 6 : asset.decimals);
      let refusal: string | undefined;
      if (raw === 0n) refusal = "Order resolves to zero";
      else if (state.orders >= caps.max_orders_per_period) refusal = "Order count limit reached";
      else if (now - previousFire < caps.cooldown_secs * 1000) refusal = "Cooldown active";
      else if (action.side === "buy") {
        if (new Money(exact).gt(caps.per_order)) refusal = "Per-order cap exceeded";
        else if (new Money(state.periodSpent).plus(exact).gt(caps.per_period))
          refusal = "Period cap exceeded";
        else if (new Money(state.lifetime).plus(exact).gt(caps.lifetime))
          refusal = "Lifetime cap exceeded";
      } else if (new Money(exact).gt(remainingPositions[asset.token.toLowerCase()] ?? "0"))
        refusal = "Insufficient stock balance";
      if (refusal) {
        result.refused.push(refusal);
        continue;
      }
      if (action.side === "buy") {
        state.periodSpent = new Money(state.periodSpent).plus(exact).toFixed();
        state.lifetime = new Money(state.lifetime).plus(exact).toFixed();
      } else {
        remainingPositions[asset.token.toLowerCase()] = new Money(
          remainingPositions[asset.token.toLowerCase()] ?? "0",
        )
          .minus(exact)
          .toFixed();
      }
      state.orders++;
      state.totalOrders++;
      state.lastFires[chosen.key] = now;
      result.intents.push({
        asset: action.asset,
        side: action.side,
        amount: exact,
        fireKey: chosen.key,
      });
    }
    if (state.halted) break;
  }
  return result;
}

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function review(plan: Plan, envelope: Envelope) {
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
    if (description.length > 16000) throw new Error("Strategy expression is too complex to review");
    descriptions.set(node.id, description);
  }
  const c = envelope.caps;
  const card = {
    authority: [
      `Buy spend: at most ${c.per_order} USDC per order, ${c.per_period} per ${c.period_secs} seconds, ${c.lifetime} over the lifetime.`,
      `Expires ${c.expires_at}; at most ${c.max_orders_per_period} orders per period; ${c.cooldown_secs}s cooldown per rule.`,
      `Assets: ${envelope.assets.map((a) => `${a.symbol} (${a.token})`).join(", ")}. Venue: Aerodrome. Slippage: ${c.slippage_bps} bps.`,
      "Onchain permissions enforce token, periodic allowance and expiry. Strategy conditions, per-order and lifetime limits are enforced by Mandate's server. Funds temporarily pass through its spender wallet.",
    ],
    parameters: plan.params.map((p) => `${p.label}: ${p.value}`),
    rules: plan.machines.flatMap((m) =>
      m.states.flatMap((s) =>
        s.transitions.map(
          (t) =>
            `${m.id}/${s.id}: when ${descriptions.get(t.when)}, ${t.fires === "on_edge" ? "once on a rising edge" : `repeat at most ${t.max_repeats} times while true`}: ${t.actions.map((a) => (a.action === "order" ? `${a.side} ${a.size.unit === "quote" || a.size.unit === "base" ? a.size.value : `${a.size.bps} bps`} (${a.size.unit}) of ${envelope.assets[a.asset]?.symbol}` : a.action === "notify" ? `notify: ${a.message}` : a.action === "halt" ? `halt: ${a.reason}` : `set ${a.var} = ${descriptions.get(a.value)}`)).join("; ")}; enter ${t.to}.`,
        ),
      ),
    ),
    undescribable: [] as string[],
  };
  const render_text = [...card.authority, ...card.parameters, ...card.rules].join("\n");
  if (render_text.length > 64000) throw new Error("Strategy review exceeds 64000 characters");
  return {
    card,
    render_text,
    render_sha256: createHash("sha256").update(render_text).digest("hex"),
  };
}
