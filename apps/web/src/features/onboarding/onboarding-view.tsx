"use client";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  KeyRound,
  PauseCircle,
  ShieldCheck,
  Wallet,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { shortAddress } from "../../lib/format";
import { useSession } from "../auth/session-provider";
import { companies, stocks } from "../market/catalog";
import { StockLogo } from "../market/stock-logo";
import { useOnboarding } from "./onboarding-provider";

export function OnboardingView() {
  const router = useRouter();
  const session = useSession();
  const { finish } = useOnboarding();
  const [step, setStep] = useState(0);
  const [symbol, setSymbol] = useState("NVDAc");
  const [mode, setMode] = useState<"manual" | "auto">("manual");
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step > 0) heading.current?.focus();
  }, [step]);
  const leave = () => {
    finish({ status: "skipped", symbol, mode });
    // Not "/" — that is this page until you log in, so pushing there would loop. Markets is the
    // public surface, and browsing it without an account is a real answer to "skip for now".
    router.push("/markets");
  };
  const create = () => {
    finish({ status: "completed", symbol, mode });
    router.push(`/strategies?create=1&symbol=${symbol}&mode=${mode}`);
  };
  return (
    <main className="onboarding">
      <aside className="onboarding-story" aria-label="About Mandate">
        <Link href="/welcome" className="onboarding-brand">
          m<span>mandate.</span>
        </Link>
        <div className="onboarding-story-body">
          <span className="onboarding-kicker">TOKENISED EQUITIES ON BASE</span>
          <h2>
            A rule you sign.
            <br />A market you stop watching.
          </h2>
          <p className="onboarding-lede">
            Say what you want in plain terms — a stock, a price, a budget — and sign it once.
            Mandate watches Base on your behalf and only ever acts inside the limits you signed.
          </p>
          <div
            className="onboarding-illustration"
            role="img"
            aria-label="Illustration of a stock rule"
          >
            <div className="onboarding-stock">
              <StockLogo symbol={symbol} />
              <div>
                <strong>{companies[symbol]?.name}</strong>
                <span>{symbol} · On Base</span>
              </div>
              <span className="onboarding-stock-tag">Your pick</span>
            </div>
            <svg viewBox="0 0 380 150" fill="none" aria-hidden="true">
              <path
                d="M0 112L22 101L43 118L67 90L86 98L107 62L128 83L149 75L171 89L190 55L214 66L237 39L257 53L281 29L306 48L331 16L353 31L380 9"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path d="M0 94H380" stroke="currentColor" strokeDasharray="4 7" opacity=".4" />
            </svg>
            <div className="onboarding-rule">
              <span className="onboarding-rule-icon">
                {mode === "manual" ? <Bell size={19} /> : <Zap size={19} />}
              </span>
              <div>
                <strong>
                  {mode === "manual" ? "Your price. Your signal." : "Your rule. Your limit."}
                </strong>
                <span>
                  {mode === "manual"
                    ? "Know when your condition is met."
                    : "A separate approval before any automatic buy."}
                </span>
              </div>
              <Check size={17} />
            </div>
            <span className="onboarding-illustration-caption">
              An illustration of your future rule
            </span>
          </div>
        </div>
        <div className="onboarding-story-footer">
          <span className="base-dot" />
          Your keys stay yours. Nothing moves without a signature and a cap you set.
        </div>
      </aside>
      <section className="onboarding-main" aria-label="Set up your workspace">
        <header className="onboarding-top">
          <span>YOUR WORKSPACE, YOUR WAY</span>
          <button type="button" className="text-button" onClick={() => leave()}>
            Skip for now
            <ArrowRight size={14} />
          </button>
        </header>
        <div className="onboarding-flow">
          <div
            className="onboarding-progress"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={3}
            aria-valuenow={step + 1}
            aria-label="Workspace setup"
          >
            {[0, 1, 2].map((i) => (
              <span key={i} className={i <= step ? "complete" : ""} />
            ))}
          </div>
          <div className="onboarding-step" key={step}>
            <p className="onboarding-step-label">
              0{step + 1} / 03 ·{" "}
              {["A little introduction", "Make it yours", "Ready when you are"][step]}
            </p>
            <h1 ref={heading} tabIndex={-1}>
              {
                [
                  "Say it in plain terms.",
                  "What are you keeping an eye on?",
                  "Read it back, then sign once.",
                ][step]
              }
            </h1>
            <p className="onboarding-intro">
              {
                [
                  "“Buy $50 of Apple if it trades under $200, at most twice a week.” A stock, a price, a budget — that is the whole of it.",
                  "Choose a stock and how you’d like to act. You can change both when you write your strategy.",
                  "Log in to write and sign your strategy. Mandate renders your rule as plain English with every limit spelled out, and your wallet signs that exact text — not a hash you cannot read.",
                ][step]
              }
            </p>
            {step === 0 && (
              <div className="onboarding-benefits">
                <div>
                  <KeyRound size={20} />
                  <span>
                    <strong>Your keys, throughout</strong>
                    <small>
                      Mandate never holds your funds. Automatic execution runs on a spend permission
                      you grant and can revoke on chain at any time.
                    </small>
                  </span>
                </div>
                <div>
                  <ShieldCheck size={20} />
                  <span>
                    <strong>Caps you set, enforced</strong>
                    <small>
                      Per order, per period, and over the strategy&apos;s lifetime. The limits are
                      part of what you signed, so they cannot be widened without you signing again.
                    </small>
                  </span>
                </div>
                <div>
                  <PauseCircle size={20} />
                  <span>
                    <strong>A kill switch that works</strong>
                    <small>
                      Every evaluation is recorded, including the ones that decided to do nothing.
                      Pause stops new orders immediately; stop ends the strategy for good.
                    </small>
                  </span>
                </div>
              </div>
            )}
            {step === 1 && (
              <>
                <fieldset className="onboarding-stocks">
                  <legend>Start with a stock</legend>
                  {stocks.map((ticker) => (
                    <button
                      type="button"
                      key={ticker}
                      className={symbol === ticker ? "chosen" : ""}
                      aria-pressed={symbol === ticker}
                      onClick={() => setSymbol(ticker)}
                    >
                      <StockLogo symbol={ticker} small />
                      <span>
                        {companies[ticker]?.name}
                        <small>{ticker}</small>
                      </span>
                      {symbol === ticker && <Check size={15} />}
                    </button>
                  ))}
                </fieldset>
                <fieldset className="onboarding-modes">
                  <legend>How would you like to start?</legend>
                  <button
                    type="button"
                    aria-pressed={mode === "manual"}
                    className={mode === "manual" ? "chosen" : ""}
                    onClick={() => setMode("manual")}
                  >
                    <Bell size={20} />
                    <span>
                      <strong>
                        Signals first <small>Start here</small>
                      </strong>
                      <span>Watch a rule. No funds move.</span>
                    </span>
                    <span className="choice-dot" />
                  </button>
                  <button
                    type="button"
                    aria-pressed={mode === "auto"}
                    className={mode === "auto" ? "chosen" : ""}
                    onClick={() => setMode("auto")}
                  >
                    <Zap size={20} />
                    <span>
                      <strong>Automatic buys</strong>
                      <span>Needs a compatible smart wallet and spending approval.</span>
                    </span>
                    <span className="choice-dot" />
                  </button>
                </fieldset>
              </>
            )}
            {step === 2 && (
              <>
                <div className="onboarding-summary">
                  <StockLogo symbol={symbol} />
                  <div>
                    <strong>{companies[symbol]?.name}</strong>
                    <span>{mode === "manual" ? "Signal strategy" : "Automatic buy strategy"}</span>
                  </div>
                  <button type="button" className="text-button" onClick={() => setStep(1)}>
                    Change
                  </button>
                </div>
                <div className="onboarding-account">
                  <Wallet size={22} />
                  <div>
                    <strong>
                      {session.wallet
                        ? shortAddress(session.wallet)
                        : "Bring your wallet. Keep control."}
                    </strong>
                    <p>
                      {session.wallet
                        ? "Connected. Your next step is to set your price and budget."
                        : "Connecting does not authorize a trade or give Mandate spending access."}
                    </p>
                  </div>
                  {session.wallet && <Check size={18} />}
                </div>
                {!session.configured && (
                  <p className="onboarding-unavailable">
                    Wallet connection isn’t available here yet. You can still explore the sample
                    workspace.
                  </p>
                )}
                {mode === "auto" && (
                  <p className="helper">
                    Automatic buys depend on eligibility, wallet compatibility and worker
                    availability. Saved rules start paused.
                  </p>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <div className="onboarding-actions">
              {step > 0 && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Previous step"
                  onClick={() => setStep(step - 1)}
                >
                  <ArrowLeft size={19} />
                </button>
              )}
              {step < 2 ? (
                <button type="button" className="button primary" onClick={() => setStep(step + 1)}>
                  {step === 0 ? "Make it mine" : "Continue"}
                  <ArrowRight size={17} />
                </button>
              ) : session.wallet && session.authenticated ? (
                <button type="button" className="button primary" onClick={create}>
                  Create my first strategy
                  <ArrowRight size={17} />
                </button>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  disabled={!session.configured || !session.ready}
                  onClick={() => {
                    try {
                      session.login();
                    } catch {
                      setError("Couldn’t open wallet connection. Please try again.");
                    }
                  }}
                >
                  Log in
                  <Wallet size={17} />
                </button>
              )}
            </div>
            <button
              type="button"
              className="onboarding-preview text-button"
              onClick={() => {
                finish({ status: "skipped", symbol, mode });
                router.push("/markets");
              }}
            >
              Browse the market first
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
        <footer className="onboarding-footer">
          <ShieldCheck size={15} />
          <span>No trade starts during setup.</span>
          <span>On Base. By you.</span>
        </footer>
      </section>
    </main>
  );
}
