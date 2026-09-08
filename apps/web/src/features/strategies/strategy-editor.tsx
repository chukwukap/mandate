"use client";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Loader2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { Dialog } from "../../components/dialog";
import { ApiError } from "../../lib/api";
import { companies, stocks } from "../market/catalog";
import { StockLogo } from "../market/stock-logo";
import { draftInput, MAX_ASSETS, type StrategyForm, scaleAmount } from "./authoring";
import type { Draft, Strategy } from "./types";

export function StrategyEditor({
  symbol,
  initialMode = "manual",
  onClose,
  onCreate,
  call,
  sign,
}: {
  symbol: string;
  initialMode?: "manual" | "auto";
  onClose(): void;
  onCreate(strategy?: Strategy): void;
  call<T>(path: string, body?: unknown): Promise<T>;
  sign(message: string): Promise<`0x${string}`>;
}) {
  const [form, setForm] = useState<StrategyForm>({
    name: "",
    symbols: [symbol],
    shape: "levels",
    direction: "lt",
    thresholds: {},
    discountBps: "20",
    amount: "",
    budget: "",
    days: "30",
    mode: initialMode,
    authoring: "rule",
    prompt: "",
    dailyBudget: "",
    maxOrders: "10",
    cooldownMinutes: "60",
    slippageBps: "50",
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /**
   * The compiler asking for detail, which is not a failure.
   *
   * When a prompt leaves out something essential — no price, no budget, an instrument that is
   * not listed — the compiler calls `explain_missing` rather than inventing a number, and the
   * API turns that into a 422 `clarification-required`. Rendering it in the red error banner
   * told the user their request had broken when it had only been incomplete, so it gets its own
   * calmer treatment beside the prompt they are editing.
   */
  const [clarification, setClarification] = useState("");
  const update = <K extends keyof StrategyForm>(key: K, value: StrategyForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  /**
   * Toggling, with a floor of one.
   *
   * An empty basket has no valid outcome — every path from here ends in "Choose at least one
   * stock" on submit — so the last selected asset refuses to turn itself off rather than letting
   * the form reach a state it can only fail from.
   */
  const toggle = (ticker: string) =>
    setForm((current) => {
      const selected = current.symbols.includes(ticker);
      if (selected && current.symbols.length === 1) return current;
      if (!selected && current.symbols.length >= MAX_ASSETS) return current;
      return {
        ...current,
        symbols: selected
          ? current.symbols.filter((s) => s !== ticker)
          : [...current.symbols, ticker],
      };
    });
  // Keyed by symbol, so unpicking one stock and picking it again brings its price back rather
  // than sliding the next stock's price into its place.
  const setThreshold = (ticker: string, value: string) =>
    setForm((current) => ({ ...current, thresholds: { ...current.thresholds, [ticker]: value } }));
  const basketDay = scaleAmount(form.amount, form.symbols.length);
  const first = form.symbols[0] ?? symbol;
  const name =
    form.name.trim() ||
    (form.symbols.length === 1
      ? `${companies[first]?.name ?? first} entry`
      : `${form.symbols.length} stocks`);
  const review = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setClarification("");
    setBusy(true);
    try {
      const input = draftInput({ ...form, name });
      setDraft(await call<Draft>("/v1/strategies/draft", input));
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
  return (
    <Dialog
      title={draft ? "One last look." : "Make your next move."}
      eyebrow={draft ? "REVIEW YOUR STRATEGY" : "NEW STRATEGY"}
      onClose={onClose}
    >
      <div className="steps">
        <span className="done">
          <span>{draft ? <Check size={12} /> : "1"}</span>Set your rule
        </span>
        <i />
        <span className={draft ? "done" : ""}>
          <span>2</span>Review & save
        </span>
      </div>
      {draft ? (
        <div className="review-body">
          <div className="review-title">
            <ShieldCheck size={24} />
            <div>
              <h3>{draft.name}</h3>
              <p>Your wallet signs this exact review.</p>
            </div>
          </div>
          <pre className="signed-review">{draft.render_text}</pre>
          <p className="helper">
            Saved strategies start paused.
            {form.mode === "auto" && " Automatic mode needs a separate spending approval."}
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              <ArrowLeft size={16} />
              Edit
            </button>
            <button type="button" className="button primary" disabled={busy} onClick={save}>
              {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />} {"Sign & save"}
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={review} className="editor-form">
          <fieldset className="authoring-switch">
            <legend>Build your strategy</legend>
            <button
              type="button"
              aria-pressed={form.authoring === "rule"}
              className={form.authoring === "rule" ? "active" : ""}
              onClick={() => update("authoring", "rule")}
            >
              Price rule
            </button>
            <button
              type="button"
              aria-pressed={form.authoring === "text"}
              className={form.authoring === "text" ? "active" : ""}
              onClick={() => update("authoring", "text")}
            >
              Describe a strategy
            </button>
          </fieldset>
          <label>
            Strategy name <span className="optional">Optional</span>
            <input
              value={form.name}
              maxLength={100}
              onChange={(e) => update("name", e.target.value)}
              placeholder="Give this one a name"
              autoComplete="off"
            />
          </label>
          <div className="form-section">
            <span className="field-label">
              {form.authoring === "rule" ? "Watch these stocks" : "Stocks"}
              {form.symbols.length > 1 ? (
                <span className="field-count">{form.symbols.length} selected</span>
              ) : null}
            </span>
            <div className="asset-options">
              {stocks.map((ticker) => {
                const selected = form.symbols.includes(ticker);
                return (
                  <button
                    key={ticker}
                    type="button"
                    aria-pressed={selected}
                    className={selected ? "selected" : ""}
                    onClick={() => toggle(ticker)}
                  >
                    {/* The catalogue's own mark, with the coloured initial as its fallback.
                        This picker used to hand-render the initial and never reach for the
                        image at all, which is why every other asset row in the app had a logo
                        and this one did not. */}
                    <StockLogo symbol={ticker} small />
                    {ticker.replace("c", "")}
                  </button>
                );
              })}
            </div>
            <span className="helper">
              Pick more than one and each stock gets its own rule, evaluated independently — one
              triggering never holds up another.
            </span>
          </div>
          {form.authoring === "rule" ? (
            <>
              <div className="form-section">
                <span className="field-label">Trigger</span>
                <div className="shape-options">
                  <button
                    type="button"
                    aria-pressed={form.shape === "levels"}
                    className={form.shape === "levels" ? "selected" : ""}
                    onClick={() => update("shape", "levels")}
                  >
                    <strong>A price for each</strong>
                    <span>Buy when a stock crosses the level you set for it.</span>
                  </button>
                  <button
                    type="button"
                    aria-pressed={form.shape === "discount"}
                    className={form.shape === "discount" ? "selected" : ""}
                    onClick={() => update("shape", "discount")}
                  >
                    <strong>Cheaper than the reference</strong>
                    <span>Buy whichever one the pool is discounting against Chainlink.</span>
                  </button>
                </div>
              </div>
              {form.shape === "levels" ? (
                <>
                  <label>
                    Condition
                    <div className="select-wrap">
                      <select
                        value={form.direction}
                        onChange={(e) => update("direction", e.target.value as "lt" | "gt")}
                      >
                        <option value="lt">Falls below</option>
                        <option value="gt">Rises above</option>
                      </select>
                      <ChevronDown size={16} />
                    </div>
                  </label>
                  <div className="threshold-rows">
                    {form.symbols.map((ticker) => (
                      <label key={ticker} className="threshold-row">
                        <span className="threshold-asset">
                          <StockLogo symbol={ticker} small />
                          {ticker.replace("c", "")}
                        </span>
                        <div className="input-affix">
                          <span>$</span>
                          <input
                            required
                            type="number"
                            min="0.000001"
                            step="0.000001"
                            placeholder="0.00"
                            aria-label={`Target price for ${companies[ticker]?.name ?? ticker}`}
                            value={form.thresholds[ticker] ?? ""}
                            onChange={(e) => setThreshold(ticker, e.target.value)}
                          />
                        </div>
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <label>
                  Discount to the Chainlink reference
                  <div className="input-affix suffix">
                    <input
                      required
                      type="number"
                      min="1"
                      max="2000"
                      step="1"
                      placeholder="20"
                      value={form.discountBps}
                      onChange={(e) => update("discountBps", e.target.value)}
                    />
                    <span>bps</span>
                  </div>
                  <span className="helper">
                    100 bps is 1%. The quote used is what a real buy would cost on Aerodrome, fees
                    and impact included, so it normally sits a little above the reference — 20 bps
                    is already a genuine dislocation. Anything more than 5% under is treated as a
                    broken pool and skipped.
                  </span>
                </label>
              )}
              <div className="rule-divider">
                <ArrowRight size={14} />
                <span>then buy</span>
              </div>
            </>
          ) : (
            <label>
              Describe your strategy
              <textarea
                required
                rows={4}
                maxLength={4000}
                value={form.prompt}
                onChange={(event) => update("prompt", event.target.value)}
                placeholder="Describe the condition, action, and amount you have in mind."
              />
              <span className="helper">
                You’ll review the compiled rule before signing. The compiler may ask for more
                detail.
              </span>
            </label>
          )}
          <div className="form-row">
            <label>
              {form.authoring === "rule" ? "Amount per buy" : "Per-order buy limit"}
              <div className="input-affix">
                <span>$</span>
                <input
                  required
                  type="number"
                  min="0.000001"
                  step="0.000001"
                  placeholder="0.00"
                  value={form.amount}
                  onChange={(e) => update("amount", e.target.value)}
                />
                <small>USDC</small>
              </div>
              {/* The single most surprising thing about a basket: this limit is enforced per
                  order, so N stocks triggering together spend N times it in one day. Saying so
                  here is cheaper than a user discovering it from their statement. */}
              {form.symbols.length > 1 && basketDay ? (
                <span className="helper">
                  Per stock. All {form.symbols.length} triggering on the same day spends up to $
                  {basketDay}, which your daily budget and order limit still cap.
                </span>
              ) : null}
            </label>
            <label>
              Total budget
              <div className="input-affix">
                <span>$</span>
                <input
                  required
                  type="number"
                  min="0.000001"
                  step="0.000001"
                  placeholder="0.00"
                  value={form.budget}
                  onChange={(e) => update("budget", e.target.value)}
                />
                <small>USDC</small>
              </div>
            </label>
          </div>
          <div className="form-row">
            <label>
              Run for
              <div className="select-wrap">
                <select value={form.days} onChange={(e) => update("days", e.target.value)}>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </select>
                <ChevronDown size={16} />
              </div>
            </label>
            <label>
              Execution
              <div className="select-wrap">
                <select
                  value={form.mode}
                  onChange={(e) => update("mode", e.target.value as "manual" | "auto")}
                >
                  <option value="manual">Signal only</option>
                  <option value="auto">Automatic buy</option>
                </select>
                <ChevronDown size={16} />
              </div>
            </label>
          </div>
          <details className="review-details advanced-limits">
            <summary>
              Advanced limits
              <ChevronDown size={15} />
            </summary>
            <div className="form-row">
              <label>
                Daily budget
                <input
                  type="number"
                  min="0.000001"
                  step="0.000001"
                  placeholder="Same as total budget"
                  value={form.dailyBudget}
                  onChange={(event) => update("dailyBudget", event.target.value)}
                />
              </label>
              <label>
                Orders per day
                <input
                  required
                  type="number"
                  min="1"
                  max="10000"
                  step="1"
                  value={form.maxOrders}
                  onChange={(event) => update("maxOrders", event.target.value)}
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                Cooldown (minutes)
                <input
                  required
                  type="number"
                  min="0"
                  max="525600"
                  step="1"
                  value={form.cooldownMinutes}
                  onChange={(event) => update("cooldownMinutes", event.target.value)}
                />
              </label>
              <label>
                Slippage (basis points)
                <input
                  required
                  type="number"
                  min="1"
                  max="500"
                  step="1"
                  value={form.slippageBps}
                  onChange={(event) => update("slippageBps", event.target.value)}
                />
                <span className="helper">50 basis points = 0.5%</span>
              </label>
            </div>
          </details>
          <p className="helper">
            {form.mode === "manual"
              ? "Get a signal when your rule fires. You stay in control."
              : "A compatible smart wallet and spending approval are required."}
          </p>
          {clarification && (
            <p className="form-clarify" role="status">
              <Sparkles size={15} />
              {clarification}
            </p>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <span className="quiet">Nothing moves until you approve.</span>
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? <Loader2 size={16} className="spin" /> : null}Review strategy
              <ArrowRight size={16} />
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
