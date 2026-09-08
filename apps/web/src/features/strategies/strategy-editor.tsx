"use client";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog } from "../../components/dialog";
import { ApiError } from "../../lib/api";
import { companies, stocks } from "../market/catalog";
import { StockLogo } from "../market/stock-logo";
import { draftInput, ladderRungs, MAX_ASSETS, type StrategyForm } from "./authoring";
import { project } from "./plan-preview";
import { PriceField } from "./price-field";
import { ReviewCard } from "./review-card";
import { ShapeGlyph } from "./shape-glyph";
import { SHAPES, type ShapeId, STARTERS, shapeById } from "./shapes";
import type { Draft, Strategy } from "./types";

/** Blank enough to be honest, defaulted enough to be usable. */
function emptyForm(symbol: string, mode: "manual" | "auto"): StrategyForm {
  return {
    name: "",
    symbols: [symbol],
    shape: "levels",
    direction: "lt",
    thresholds: {},
    discountBps: "20",
    cadenceHours: "168",
    ladderStart: "",
    ladderStepPct: "4",
    ladderMultiple: "1.6",
    ladderRungs: "4",
    amount: "",
    budget: "",
    days: "30",
    mode,
    authoring: "rule",
    prompt: "",
    dailyBudget: "",
    maxOrders: "10",
    cooldownMinutes: "60",
    slippageBps: "50",
  };
}

const money = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? `$${parsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : "—";
};

/** A row of exclusive options. The pattern every good money app uses instead of a <select>. */
function Segment<T extends string>({
  value,
  options,
  onChange,
  big = false,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  big?: boolean;
}) {
  return (
    <div className={`segment ${big ? "big" : ""}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function StrategyEditor({
  symbol,
  initialMode = "manual",
  onClose,
  onCreate,
  call,
  sign,
  price,
  priceStale,
}: {
  symbol: string;
  initialMode?: "manual" | "auto";
  onClose(): void;
  onCreate(strategy?: Strategy): void;
  call<T>(path: string, body?: unknown): Promise<T>;
  sign(message: string): Promise<`0x${string}`>;
  /** Today's oracle price, so a threshold can be judged against something. */
  price(symbol: string): string | undefined;
  /** True when that price is a held close rather than a live reading — say so, do not hide it. */
  priceStale(symbol: string): boolean;
}) {
  /**
   * Three screens, and the first one asks a question rather than presenting a form.
   *
   * Every platform researched makes the bot type the entire first screen with nothing else on
   * it, and the reason is legible here: until the shape is known, none of the other fields mean
   * anything definite. "Amount" means five different things across the five shapes.
   */
  const [step, setStep] = useState<"shape" | "setup">("shape");
  const [form, setForm] = useState<StrategyForm>(() => emptyForm(symbol, initialMode));
  const [cash, setCash] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** The compiler asking for detail, which is not a failure and must not look like one. */
  const [clarification, setClarification] = useState("");

  useEffect(() => {
    let cancelled = false;
    void call<{ cash: string }>("/v1/portfolio")
      .then((p) => {
        if (!cancelled) setCash(p.cash);
      })
      // An affordability hint is an assist, not a gate.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [call]);

  const update = <K extends keyof StrategyForm>(key: K, value: StrategyForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const shape = shapeById(form.shape);

  const chooseShape = (id: ShapeId) => {
    setForm((current) => ({
      ...current,
      shape: id,
      authoring: "rule",
      // A ladder addresses one stock by its rung indexes; keep the first if a basket was chosen.
      symbols: shapeById(id).single ? current.symbols.slice(0, 1) : current.symbols,
      ladderStart:
        id === "ladder" && !current.ladderStart
          ? (price(current.symbols[0] ?? symbol) ?? "")
          : current.ladderStart,
    }));
    setStep("setup");
  };

  const applyStarter = (id: string) => {
    const starter = STARTERS.find((s) => s.id === id);
    if (!starter) return;
    const anchor = starter.symbols[0] ?? symbol;
    setForm((current) => ({
      ...current,
      ...starter.form,
      shape: starter.shape,
      authoring: "rule",
      symbols: [...starter.symbols],
      // Prices come from today's market, never from a constant written weeks ago.
      ladderStart: starter.shape === "ladder" ? (price(anchor) ?? "") : current.ladderStart,
      thresholds:
        starter.shape === "levels" && price(anchor)
          ? { [anchor]: (Number(price(anchor)) * 0.95).toFixed(2) }
          : current.thresholds,
      name: starter.title,
    }));
    setStep("setup");
  };

  const toggle = (ticker: string) =>
    setForm((current) => {
      if (shapeById(current.shape).single) return { ...current, symbols: [ticker] };
      const selected = current.symbols.includes(ticker);
      // Never empty and never over the machine cap: the picker refuses rather than letting the
      // form reach a state whose only outcome is an error on submit.
      if (selected && current.symbols.length === 1) return current;
      if (!selected && current.symbols.length >= MAX_ASSETS) return current;
      return {
        ...current,
        symbols: selected
          ? current.symbols.filter((s) => s !== ticker)
          : [...current.symbols, ticker],
      };
    });

  const setThreshold = (ticker: string, value: string) =>
    setForm((current) => ({ ...current, thresholds: { ...current.thresholds, [ticker]: value } }));

  const first = form.symbols[0] ?? symbol;
  const name =
    form.name.trim() ||
    (form.symbols.length === 1
      ? `${companies[first]?.name ?? first} ${shape.also.toLowerCase()}`
      : `${form.symbols.length} stocks`);

  /** Live, from today's numbers. A forward projection — never a claim about the past. */
  const projection = project(form, price, cash);

  const rungs = (() => {
    if (form.shape !== "ladder" || form.authoring !== "rule") return null;
    try {
      return ladderRungs(form);
    } catch {
      return null;
    }
  })();

  const review = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setClarification("");
    setBusy(true);
    try {
      setDraft(await call<Draft>("/v1/strategies/draft", draftInput({ ...form, name })));
    } catch (e) {
      if (e instanceof ApiError && e.code === "clarification-required") setClarification(e.message);
      else setError(e instanceof Error ? e.message : "Couldn't prepare the review.");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const signature = await sign(draft.confirm_message);
      await call("/v1/strategies", { artifact_id: draft.artifact_id, signature });
      onCreate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save your strategy.");
    } finally {
      setBusy(false);
    }
  };

  const stepIndex = draft ? 2 : step === "shape" ? 0 : 1;
  const worstCase =
    form.budget && form.days
      ? {
          total: money(form.budget),
          expires: new Date(Date.now() + Number(form.days) * 86_400_000).toLocaleDateString(
            undefined,
            { day: "numeric", month: "long", year: "numeric" },
          ),
        }
      : null;

  const stepper = (
    <ol className="stepper" aria-label="Progress">
      {["Choose", "Set up", "Review"].map((label, index) => (
        <li
          key={label}
          className={index < stepIndex ? "done" : index === stepIndex ? "current" : ""}
          aria-current={index === stepIndex ? "step" : undefined}
        >
          <i>{index < stepIndex ? <Check size={11} /> : index + 1}</i>
          {label}
        </li>
      ))}
    </ol>
  );

  return (
    <Dialog
      title={draft ? "One last look." : step === "shape" ? "What should it do?" : "Set it up."}
      eyebrow="NEW STRATEGY"
      onClose={onClose}
      size={draft || step === "shape" ? "wide" : "xl"}
    >
      {stepper}

      {draft ? (
        <div className="review step-enter">
          <ReviewCard draft={draft} worstCase={worstCase} automatic={form.mode === "auto"} />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="actions">
            <button type="button" className="button secondary" onClick={() => setDraft(null)}>
              <ArrowLeft size={15} /> Back
            </button>
            <button type="button" className="button primary" disabled={busy} onClick={save}>
              {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
              {form.mode === "auto" ? "Sign & turn it on" : "Sign & watch"}
            </button>
          </div>
        </div>
      ) : step === "shape" ? (
        <div className="choose step-enter">
          <div className="recipes">
            <span className="eyebrow-label">Try one</span>
            <div className="recipe-row">
              {STARTERS.map((starter) => (
                <button
                  key={starter.id}
                  type="button"
                  className="recipe"
                  onClick={() => applyStarter(starter.id)}
                >
                  <ShapeGlyph shape={starter.shape} size={26} />
                  <span>{starter.title}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="shape-list">
            <span className="eyebrow-label">Or build your own</span>
            {SHAPES.map((option) => (
              <button
                key={option.id}
                type="button"
                className="shape-row"
                onClick={() => chooseShape(option.id)}
              >
                <span className="shape-row-glyph">
                  <ShapeGlyph shape={option.id} />
                </span>
                <span className="shape-row-text">
                  <strong>{option.goal}</strong>
                  <span>{option.mechanism}</span>
                  {option.caveat && <em>{option.caveat}</em>}
                </span>
                <span className="shape-row-tag">{option.also}</span>
                <ChevronRight size={16} className="shape-row-go" />
              </button>
            ))}
          </div>

          <button
            type="button"
            className="describe-link"
            onClick={() => {
              update("authoring", "text");
              setStep("setup");
            }}
          >
            <Sparkles size={15} />
            Describe it in your own words instead
          </button>
        </div>
      ) : (
        <form onSubmit={review} className="setup step-enter">
          <div className="setup-main">
            <button type="button" className="chosen" onClick={() => setStep("shape")}>
              {form.authoring === "rule" ? (
                <>
                  <span className="chosen-glyph">
                    <ShapeGlyph shape={form.shape} size={30} />
                  </span>
                  <span className="chosen-text">
                    <strong>{shape.goal}</strong>
                    <em>{shape.also}</em>
                  </span>
                </>
              ) : (
                <>
                  <span className="chosen-glyph">
                    <Sparkles size={18} />
                  </span>
                  <span className="chosen-text">
                    <strong>Described in your words</strong>
                    <em>Compiled for you</em>
                  </span>
                </>
              )}
              <span className="chosen-change">Change</span>
            </button>

            {form.authoring === "text" ? (
              <section className="block">
                <header>
                  <h3>Describe it</h3>
                </header>
                <textarea
                  required
                  rows={5}
                  maxLength={4000}
                  className="prompt"
                  value={form.prompt}
                  onChange={(event) => update("prompt", event.target.value)}
                  placeholder="e.g. Buy $50 of Apple every time it falls 5% below where it is now, up to $400."
                />
                <p className="hint">
                  You'll review the compiled rule before signing. If something essential is missing,
                  the compiler asks rather than guessing.
                </p>
              </section>
            ) : (
              <>
                <section className="block">
                  <header>
                    <h3>{shape.single ? "Stock" : "Stocks"}</h3>
                    {!shape.single && form.symbols.length > 1 && (
                      <span>{form.symbols.length} selected</span>
                    )}
                  </header>
                  <div className="stock-rings">
                    {stocks.map((ticker) => {
                      const selected = form.symbols.includes(ticker);
                      return (
                        <button
                          key={ticker}
                          type="button"
                          className={`stock-ring ${selected ? "on" : ""}`}
                          aria-pressed={selected}
                          onClick={() => toggle(ticker)}
                        >
                          <span className="stock-ring-mark">
                            <StockLogo symbol={ticker} />
                            {selected && (
                              <i>
                                <Check size={10} />
                              </i>
                            )}
                          </span>
                          <span>{ticker.replace("c", "")}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>

                {form.shape === "levels" && (
                  <section className="block">
                    <header>
                      <h3>Trigger</h3>
                    </header>
                    <Segment
                      value={form.direction}
                      options={[
                        { value: "lt", label: "Falls below" },
                        { value: "gt", label: "Rises above" },
                      ]}
                      onChange={(value) => update("direction", value)}
                    />
                    <div className="prices">
                      {form.symbols.map((ticker) => (
                        <PriceField
                          key={ticker}
                          symbol={ticker}
                          spot={price(ticker)}
                          stale={priceStale(ticker)}
                          value={form.thresholds[ticker] ?? ""}
                          direction={form.direction}
                          onChange={(value) => setThreshold(ticker, value)}
                        />
                      ))}
                    </div>
                  </section>
                )}

                {form.shape === "recurring" && (
                  <section className="block">
                    <header>
                      <h3>How often</h3>
                    </header>
                    <Segment
                      value={form.cadenceHours}
                      options={[
                        { value: "24", label: "Daily" },
                        { value: "168", label: "Weekly" },
                        { value: "336", label: "Fortnightly" },
                        { value: "720", label: "Monthly" },
                      ]}
                      onChange={(value) => update("cadenceHours", value)}
                    />
                    <p className="hint">
                      Whatever the price is doing. The interval becomes the minimum gap between buys
                      on your signed limits.
                    </p>
                  </section>
                )}

                {form.shape === "ladder" && (
                  <section className="block">
                    <header>
                      <h3>Steps</h3>
                    </header>
                    <PriceField
                      symbol={first}
                      spot={price(first)}
                      stale={priceStale(first)}
                      value={form.ladderStart}
                      direction="lt"
                      onChange={(value) => update("ladderStart", value)}
                    />
                    <div className="trio">
                      <label className="field">
                        <span>Steps</span>
                        <div className="field-input">
                          <input
                            required
                            inputMode="numeric"
                            value={form.ladderRungs}
                            onChange={(e) => update("ladderRungs", e.target.value)}
                          />
                        </div>
                      </label>
                      <label className="field">
                        <span>Each lower by</span>
                        <div className="field-input">
                          <input
                            required
                            inputMode="decimal"
                            value={form.ladderStepPct}
                            onChange={(e) => update("ladderStepPct", e.target.value)}
                          />
                          <b>%</b>
                        </div>
                      </label>
                      <label className="field">
                        <span>Each bigger by</span>
                        <div className="field-input">
                          <input
                            required
                            inputMode="decimal"
                            value={form.ladderMultiple}
                            onChange={(e) => update("ladderMultiple", e.target.value)}
                          />
                          <b>×</b>
                        </div>
                      </label>
                    </div>
                    {rungs && (
                      <ol className="rungs">
                        {rungs.map((rung, index) => (
                          <li key={rung.price}>
                            <span>Step {index + 1}</span>
                            <em>under ${Number(rung.price).toFixed(2)}</em>
                            <strong>${rung.amount}</strong>
                          </li>
                        ))}
                      </ol>
                    )}
                  </section>
                )}

                {form.shape === "discount" && (
                  <section className="block">
                    <header>
                      <h3>How much cheaper</h3>
                    </header>
                    <div className="chips">
                      {[
                        ["10", "0.10%"],
                        ["20", "0.20%"],
                        ["50", "0.50%"],
                        ["100", "1.00%"],
                      ].map(([bps, label]) => (
                        <button
                          key={bps}
                          type="button"
                          aria-pressed={form.discountBps === bps}
                          onClick={() => update("discountBps", bps as string)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <label className="field">
                      <span>Or exactly</span>
                      <div className="field-input">
                        <input
                          required
                          inputMode="decimal"
                          value={form.discountBps}
                          onChange={(e) => update("discountBps", e.target.value)}
                        />
                        <b>bps</b>
                      </div>
                    </label>
                    <p className="hint">
                      The pool quote already includes fees and impact, so it normally sits a little
                      above the reference — 0.20% below is already a real dislocation. More than 5%
                      under is treated as a broken pool and skipped.
                    </p>
                  </section>
                )}

                {form.shape === "rebalance" && (
                  <section className="block">
                    <header>
                      <h3>Target</h3>
                    </header>
                    <p className="hint">
                      An even split
                      {form.symbols.length > 1
                        ? ` — about ${(100 / form.symbols.length).toFixed(0)}% each`
                        : ""}
                      . Whichever stock falls below its share gets topped up.
                    </p>
                  </section>
                )}
              </>
            )}

            <section className="block">
              <header>
                <h3>Money</h3>
                {cash && <span>You hold {money(cash)} USDC</span>}
              </header>
              <div className="money">
                <label className="field big">
                  <span>{form.shape === "ladder" ? "First step" : "Per buy"}</span>
                  <div className="field-input">
                    <i>$</i>
                    {/* inputMode rather than type=number: a scroll gesture over a focused
                        number input silently changes the amount that is about to be signed. */}
                    <input
                      required
                      inputMode="decimal"
                      placeholder="0"
                      value={form.amount}
                      onChange={(e) => update("amount", e.target.value)}
                    />
                    <b>USDC</b>
                  </div>
                </label>
                <label className="field big">
                  <span>Total budget</span>
                  <div className="field-input">
                    <i>$</i>
                    <input
                      required
                      inputMode="decimal"
                      placeholder="0"
                      value={form.budget}
                      onChange={(e) => update("budget", e.target.value)}
                    />
                    <b>USDC</b>
                  </div>
                </label>
              </div>
              <div className="field">
                <span>Run for</span>
                <Segment
                  value={form.days}
                  options={[
                    { value: "7", label: "1 week" },
                    { value: "30", label: "1 month" },
                    { value: "90", label: "3 months" },
                    { value: "180", label: "6 months" },
                  ]}
                  onChange={(value) => update("days", value)}
                />
              </div>
            </section>

            {/* A consequential choice that used to be a two-option <select> beside "Run for". */}
            <section className="block">
              <header>
                <h3>When it fires</h3>
              </header>
              <Segment
                big
                value={form.mode}
                options={[
                  { value: "manual", label: "Tell me" },
                  { value: "auto", label: "Buy it for me" },
                ]}
                onChange={(value) => update("mode", value)}
              />
              <p className="hint">
                {form.mode === "manual"
                  ? "You get a signal and decide. Nothing can spend your money."
                  : "After signing you approve a spending limit — a separate onchain step you can revoke at any time."}
              </p>
            </section>

            <details className="guardrails">
              <summary>
                <span>Guardrails</span>
                <em>
                  {form.maxOrders} buys a day · {form.slippageBps} bps slippage
                  {form.shape !== "recurring" && ` · ${form.cooldownMinutes} min apart`}
                </em>
                <ChevronDown size={15} />
              </summary>
              <div className="guardrails-grid">
                <label className="field">
                  <span>Most in one day</span>
                  <div className="field-input">
                    <i>$</i>
                    <input
                      inputMode="decimal"
                      placeholder="Same as budget"
                      value={form.dailyBudget}
                      onChange={(event) => update("dailyBudget", event.target.value)}
                    />
                  </div>
                </label>
                <label className="field">
                  <span>Buys per day</span>
                  <div className="field-input">
                    <input
                      inputMode="numeric"
                      value={form.maxOrders}
                      onChange={(event) => update("maxOrders", event.target.value)}
                    />
                  </div>
                </label>
                {form.shape !== "recurring" && (
                  <label className="field">
                    <span>Minimum gap</span>
                    <div className="field-input">
                      <input
                        inputMode="numeric"
                        value={form.cooldownMinutes}
                        onChange={(event) => update("cooldownMinutes", event.target.value)}
                      />
                      <b>min</b>
                    </div>
                  </label>
                )}
                <label className="field">
                  <span>Slippage</span>
                  <div className="field-input">
                    <input
                      inputMode="numeric"
                      value={form.slippageBps}
                      onChange={(event) => update("slippageBps", event.target.value)}
                    />
                    <b>bps</b>
                  </div>
                </label>
              </div>
            </details>

            <label className="field">
              <span>
                Name <em>optional</em>
              </span>
              <div className="field-input">
                <input
                  maxLength={100}
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                  placeholder={name}
                  autoComplete="off"
                />
              </div>
            </label>

            {clarification && (
              <p className="form-clarify">
                <Sparkles size={14} />
                {clarification}
              </p>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>

          <aside className="setup-side">
            <div className="preview">
              <span className="eyebrow-label">What this does</span>
              {projection ? (
                <>
                  <p className="preview-sentence">{projection.sentence}</p>
                  {projection.today && (
                    <div className={`preview-today ${projection.today.firing ? "on" : ""}`}>
                      <i />
                      {projection.today.detail}
                    </div>
                  )}
                  {projection.facts.length > 0 && (
                    <dl className="preview-rows">
                      {projection.facts.map((fact) => (
                        <div key={fact.label}>
                          <dt>{fact.label}</dt>
                          <dd>{fact.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {projection.warnings.map((warning) => (
                    <p key={warning} className="preview-warn">
                      <AlertTriangle size={13} />
                      {warning}
                    </p>
                  ))}
                </>
              ) : (
                <p className="preview-empty">
                  Describe what you want and the compiled rule will appear here before you sign.
                </p>
              )}
            </div>
            <div className="actions">
              <button type="button" className="button secondary" onClick={() => setStep("shape")}>
                <ArrowLeft size={15} /> Back
              </button>
              <button type="submit" className="button primary" disabled={busy}>
                {busy ? <Loader2 size={16} className="spin" /> : <ArrowRight size={16} />}
                Review
              </button>
            </div>
          </aside>
        </form>
      )}
    </Dialog>
  );
}
