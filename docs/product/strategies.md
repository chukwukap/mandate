# What users can actually strategise

Everything here was established by reading the engine and by measuring the live system, not by
reasoning about what a trading product usually does. Where a claim comes from a file, the file is
named; where it comes from a measurement, the measurement is shown.

The short version: this engine sees **two prices per asset and nothing else**. It has no memory,
no clock and no history. That is a much smaller surface than it first appears, and it rules out
most of what people mean by "strategy" — but the one thing it *does* see that almost nothing else
does is the gap between a Chainlink reference and a live Aerodrome pool, and that gap is real,
tradable information.

## The catalogue

Seven Coinbase B20 tokenised equities on Base, all currently tradable:

`AAPLc` `GOOGLc` `METAc` `NVDAc` `MSFTc` `AMZNc` `TSLAc`

A single strategy's envelope carries an `assets` array, and an `order` action names one by index
into it. **One strategy can therefore span several assets**, which is the whole basis of the
cross-asset ideas below.

## The two feeds

| Feed | What it is |
| --- | --- |
| `oracle:SYMBOL` | The Chainlink total-return reference price |
| `dex:SYMBOL` | The effective price of a **$10 buy** on Aerodrome |

`dex:` is not a mid-price. It is `10 / amount_out` for a routed $10 buy
([base.ts:393-403](../../packages/evm/src/clients/base.ts)), so it already includes the pool fee
and the price impact at that size. **It is an ask, not a mid**, and that changes how its
relationship to the oracle should be read — see the measurements below.

## What a condition can read

Only these four things: `feed`, `const` (a decimal string), `param` (a static constant declared
in `plan.params`), and other `node`s.

### What a condition cannot read

This list is the important half, and every entry was verified:

| Not available | Why |
| --- | --- |
| Portfolio equity, position sizes | The portfolio is read **only inside the sizing branch** ([strategy.ts:405-408](../../packages/strategy/src/strategy.ts)), never in `resolve()`. "Buy only if I hold less than $500 of it" is **not expressible**. |
| Machine variables | `set` writes `ms.vars` and **nothing ever reads it back**. `params` come from `plan.params` ([strategy.ts:218](../../packages/strategy/src/strategy.ts)), so `set` is currently write-only and inert. |
| Time, dates, schedules | No clock is exposed. "Every Monday", "weekly DCA", "after 30 days" cannot be written. |
| Any history | No previous price, no moving average, no volume, no candles. Every condition is about *now*. |
| The strategy's own past | Order counts and spend-so-far are enforced by the envelope, outside the plan, and are not readable inside it. |

## Operators, actions, sizing

**Operators** — `add` `sub` `mul` `safe_div` `abs` `min` `max` · `gt` `gte` `lt` `lte` `eq` ·
`and` `or` `not`. Nodes are typed: comparisons and logic yield booleans, arithmetic yields
numbers, and a plan that mixes them wrongly is refused at validation.

**Actions** — `order(assetIndex, buy|sell, size)` · `notify(message)` · `halt(reason)` ·
`set(var, node)` (inert, see above).

**Sizing** — this *can* read the portfolio:

| Unit | Meaning |
| --- | --- |
| `quote` | A fixed USDC amount |
| `base` | A fixed token amount |
| `pct_equity` | Basis points of total equity |
| `pct_position` | Basis points of that asset's position |

**Machines** — `scope` must be `"portfolio"`; position-scoped machines are explicitly refused
([strategy.ts:187](../../packages/strategy/src/strategy.ts)). States and transitions are the only
real memory a plan has: `watch → entered → done` is expressible, and is how you stop one dip
firing a rule repeatedly. `fires: on_edge` fires once when a condition becomes true;
`while_true` fires every tick while it holds and requires a finite `max_repeats`.

**Caps are not plan logic.** Per-order, per-period, lifetime, order count, cooldown, expiry and
slippage all live in the signed envelope and are enforced outside the plan. Writing a frequency
limit into plan logic duplicates a limit the user already set, and usually fails validation.

## The basis, measured

Sampled from the live API on 2026-09-08 with US markets open, five readings ~35s apart:

| Asset | Basis `dex/oracle − 1` | Movement over 3 min |
| --- | --- | --- |
| AAPLc | +0.170% | +0.170 → +0.171 |
| GOOGLc | −0.048% | flat |
| METAc | +0.389% | flat |
| NVDAc | +0.405% | +0.405 → +0.406 |
| MSFTc | +0.153% | flat |
| AMZNc | +0.380% | +0.380 → +0.397 |
| TSLAc | +0.537% | **+0.537 → +0.555 → +0.020 → +0.101** |

Two things follow, and both matter more than they look.

**The persistent positive basis is mostly the spread, not a premium.** `dex:` is a $10 ask, so it
sits above the mid by roughly the pool's fee plus impact. Each asset therefore has its **own
baseline** — GOOGLc's is around −0.05%, NVDAc's around +0.41% — and a threshold that is
meaningful for one is meaningless for another. A naive "buy when `dex < oracle`" rule would fire
constantly on GOOGLc and essentially never on TSLAc.

**The basis is a live signal for some assets and static for others.** Five of the seven barely
moved over three minutes. TSLAc swung 0.5 percentage points. A basis strategy is really a TSLAc
strategy today, and a strategy author should calibrate per asset rather than picking one number
for all seven.

## Execution reality

**A strategy containing a sell action cannot run at all.** This is stronger than "buy-only", and
the earlier framing in this document was wrong.

`requiresSellAuthority()` ([permission.ts:55](../../apps/api/src/modules/permissions/permission.ts))
walks every transition of every state looking for one `order` action with `side: "sell"`. If it
finds one, the spend-permission route answers `409 sell-permission-required`, so no permission is
ever issued — and [instances/routes.ts:173](../../apps/api/src/modules/instances/routes.ts)
refuses to arm an auto instance without one. A single sell action anywhere, **even in a state the
machine can never reach**, makes the whole plan unrunnable, buys included.

If such an instance did reach the worker anyway, the backstop is `guard()` at
[chain.ts:229](../../apps/worker/src/chain.ts) throwing `Unsupported order`, and the order is
cancelled before a single byte is signed. But it is not free: a phantom sell still consumes an
order slot and starts that rule's cooldown, so it can block a real buy.

### Auto strategies only run 09:35–15:55 ET, Mon–Fri

[chain.ts:52-63](../../apps/worker/src/chain.ts) gates automatic execution to regular trading
hours. Admission calls `authorize()` *before* it takes a market snapshot, so an auto instance
does not even tick outside that window. Every strategy here is an RTH strategy whether its
author wanted that or not — a level breached at 4am is discovered hours later.

What risk control *is* available:

- `halt` as a circuit breaker, ending the strategy when a condition says the world changed
- `notify` as a stop-loss alert
- the envelope caps — per-order, per-period, lifetime, `expires_at` — which are the real limit
- machine states that refuse to re-enter after an exit condition

## Mechanics that will surprise you

Each of these was found by *running* `tick()`, not by reading the code, and each has bitten a
draft strategy.

**One transition fires per machine per tick.** A three-rung ladder advances one rung per cadence
interval even when the price gaps through all three at once — so the fills happen at whatever the
pool offers over the next three ticks, not at the rung levels.

**`on_edge` memory is keyed `state/index`, and only the current state's transitions are
refreshed.** A guard that was true when the machine left a state is still recorded true when it
returns, so the first true after a round trip is *not* a rising edge. A two-state
`watch → filled → watch` dip-buyer silently misses its second dip. The fix is a self-loop —
`to` pointing at the state the machine is already in — so the guard is re-evaluated and the edge
reset every tick.

**`while_true` repeats burn on refusal.** `ms.repeats` increments when the transition is *chosen*,
before the envelope applies caps. A `max_repeats` of 5 with a 3600s cooldown on a 60s cadence
placed **one** order and consumed all five. Also: the counter resets when the guard goes false, so
it bounds one episode, not the strategy — the lifetime budget is the envelope.

**Several orders in one transition share that firing's cooldown.** `previousFire` is captured once
before the action loop, so a basket of seven buys all fill on one tick even under a long cooldown.
This is what makes single-trigger basket entry work at all.

**`halt` discards intents from earlier machines in the same tick.**
[admission.ts:158](../../packages/execution/src/admission.ts) replaces the intent list wholesale
when halted, so declaration order does not weaken a circuit breaker. `halt` is terminal and
one-way — one transient bad print stops the strategy until the user re-arms.

**The condition is re-checked at funding time.** `guard()` re-runs `evaluate()` on a *fresh*
snapshot before pulling funds and again before the swap, cancelling with "Order condition no
longer holds". Excellent — you never fund a discount that has already closed — but it means
thresholds must be **bands that persist**, not knife-edge crossings, or fills get cancelled
routinely.

**Observation is all-or-nothing.** `snapshot()` requires *both* feeds for *every* asset in the
envelope and refuses any stale or null one. One dead pool silences the whole strategy. Wide
seven-asset envelopes are the most fragile plans in the library for exactly this reason.

**Budget reservations are one-way.** A cancelled, reverted or refunded order never gives its spend
back. That errs toward under-spending a signed authority, which is the safe direction, but a bad
week of cancelled orders can exhaust a lifetime cap without a single fill.

**`min()` returns one of its inputs unchanged**, so `eq(x, min(...))` is an exact argmin with no
tolerance needed. This is the single most useful cross-asset trick the engine has, and two of the
multi-token strategies below are built on it.

**`notify` has no delivery.** Notifications are appended to `evaluations.notifications` and shown
in the activity view. There is no email, webhook, push or SMS anywhere in the repo. A stop alert
only protects a user who is looking.

## The strategy library

Seventeen plans, every one re-validated against `validatePlan` with the real seven-asset
catalogue. They live in [`strategies/`](strategies/) as JSON you can paste into a draft.

Asset indices are indices into the **envelope's** `assets` array. These were validated against the
full catalogue — `0 AAPLc, 1 GOOGLc, 2 METAc, 3 NVDAc, 4 MSFTc, 5 AMZNc, 6 TSLAc` — so if you sign
a narrower envelope the indices must be remapped.

### Single asset

| Plan | What it does |
| --- | --- |
| [`single-limit-buy`](strategies/single-limit-buy.json) | Buy $250 of NVDAc the first time the oracle prints below $150, then stop. Terminal state makes it genuinely one-shot rather than cap-limited. |
| [`single-ladder-three-rung`](strategies/single-ladder-three-rung.json) | $200 under $230, $300 under $220, $500 under $210. Each rung its own state, so the machine only walks forward. |
| [`single-thin-pool-gate`](strategies/single-thin-pool-gate.json) | Buy MSFTc under $400 **only while the pool is within 50bps of the oracle**. The defensive use of the two feeds. |
| [`single-rearming-dip-pct-equity`](strategies/single-rearming-dip-pct-equity.json) | A dip buyer sized on equity that re-arms via a self-loop, avoiding the stale-edge trap. |
| [`single-scale-in-bounded`](strategies/single-scale-in-bounded.json) | `while_true` accumulation into a fall, bounded by `max_repeats`. |

### The two feeds — basis

| Plan | What it does |
| --- | --- |
| [`basis-discount-crossing`](strategies/basis-discount-crossing.json) | Buy AAPLc when the ask crosses ≥20bps below the oracle, but never deeper than 200bps — a floor that excludes a broken pool. |
| [`basis-guarded-nvda`](strategies/basis-guarded-nvda.json) | A discount entry with a dislocation breaker and a stop alert. |
| [`basis-tsla-rearming`](strategies/basis-tsla-rearming.json) | TSLAc, the one asset whose basis actually moves. |
| [`basis-pair-aapl-googl`](strategies/basis-pair-aapl-googl.json) | Whichever of two names is at the better discount. |
| [`basis-scanner-seven-asset`](strategies/basis-scanner-seven-asset.json) | Scans all seven for a dislocation. Powerful, and the most fragile — see all-or-nothing observation. |

### Multi-token

| Plan | What it does |
| --- | --- |
| [`cross-ratio-aapl-msft`](strategies/cross-ratio-aapl-msft.json) | Buy Apple when it is cheap relative to Microsoft, gated on the pool not charging a premium. |
| [`cross-relative-value-seven`](strategies/cross-relative-value-seven.json) | `min()` + `eq()` argmin across all seven: buy whichever is furthest below the level **you** named. |
| [`cross-basket-entry-seven`](strategies/cross-basket-entry-seven.json) | One condition, seven `order` actions in a single transition, sized by `pct_equity`. All fill on one tick. |
| [`cross-rotation-nvda-msft`](strategies/cross-rotation-nvda-msft.json) | A machine that buys NVDA in one state and MSFT in another, rotating on relative value. |
| [`cross-basis-scanner-seven`](strategies/cross-basis-scanner-seven.json) | Cross-sectional dislocation across the whole catalogue. |

### Risk shape

| Plan | What it does |
| --- | --- |
| [`risk-guarded-entry-breaker-alert`](strategies/risk-guarded-entry-breaker-alert.json) | Entry + circuit breaker + stop alert, the fullest expression of what risk control is available. |
| [`risk-accumulate-with-breaker`](strategies/risk-accumulate-with-breaker.json) | `while_true` accumulation with a two-clause breaker. |

## The honest limit of all of it

**Every strategy here is an entry.** The engine has no way to express the exit that would complete
any of them. A ladder into a falling knife is still a falling knife; a relative-value trade you
cannot close is a long position with extra steps. The envelope caps and `expires_at` are the real
risk budget, and users should size accordingly — as money they are content to hold through the
scenario the strategy did not anticipate.

## Two validators

There are two `validatePlan` implementations and they are not the same:

- [`strategy.ts:139`](../../packages/strategy/src/strategy.ts) — exported from `@mandate/strategy`
  and used by the API route and by admission. **This is the one that binds.**
- [`validation/semantics.ts:31`](../../packages/strategy/src/validation/semantics.ts) — stricter,
  and additionally rejects `set`, `max_repeats` on an `on_edge` rule, unreachable states, and
  machines with no transitions.

Every plan in the library passes **both**, so nothing here depends on which one runs.
