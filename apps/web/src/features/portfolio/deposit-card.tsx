"use client";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { money } from "../trading/market-data";

/**
 * The one place that says where money goes.
 *
 * The embedded wallet is the strategy account: deposits land here, buys leave from here, and
 * nothing is custodied in between. The address is the whole point of the card, so it is set
 * large and monospace with the balance and the network as supporting facts — a person sending
 * from an exchange needs to read it, copy it, and see the money arrive, in that order.
 */
export function DepositCard({
  address,
  balance,
  notify,
}: {
  address: string;
  /** USDC held at `address`, or null while that is not yet known. */
  balance: string | null;
  notify(message: string): void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access is refused on insecure origins and by dismissed prompts. The address
      // is on screen either way, so say so rather than leave a button that did nothing.
      notify("Couldn't copy — select the address to copy it manually.");
    }
  };
  return (
    <section className="deposit-card" aria-labelledby="deposit-title">
      <div className="deposit-head">
        <h2 id="deposit-title">Fund your wallet</h2>
        <span className="base-label">
          <i />
          USDC on Base
        </span>
      </div>
      <div className="deposit-address">
        <code>{address}</code>
        <button
          type="button"
          className={`button secondary ${copied ? "copied" : ""}`}
          onClick={() => void copy()}
          aria-live="polite"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="deposit-foot">
        <div className="deposit-balance">
          <span>Balance</span>
          <strong>
            {money(balance)}
            <small>USDC</small>
          </strong>
        </div>
        <p>
          Send USDC on Base to this address. It is your wallet: strategies buy from it, and you can
          withdraw any time.
        </p>
      </div>
    </section>
  );
}
