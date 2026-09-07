"use client";
import { ExternalLink, Loader2 } from "lucide-react";
import { useState } from "react";
import { Status } from "../../components/status";
import type { ApiCall } from "../../lib/api";
import { useHistory } from "./use-history";
export function StrategyHistory({ instance, call }: { instance: string; call: ApiCall }) {
  const [kind, setKind] = useState<"evaluations" | "executions">("executions");
  const { page, loading, error, load } = useHistory(instance, kind, call);
  return (
    <section className="strategy-history" aria-label="Strategy history">
      <div className="panel-heading">
        <div className="tabs">
          {(["executions", "evaluations"] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={kind === value ? "active" : ""}
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
            >
              {value === "executions" ? "Orders & signals" : "Evaluations"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!page.items.length && !loading && <p className="helper">{`No ${kind} recorded yet.`}</p>}
      {page.items.map((item) => (
        <div key={item.id} className="history-entry">
          <div>
            <time>{new Date("at" in item ? item.at : item.createdAt).toLocaleString()}</time>
            {"at" in item ? (
              <>
                <strong>{item.outcome.replaceAll("_", " ")}</strong>
                <span>
                  {item.admitted} orders admitted{item.refused ? ` · ${item.refused}` : ""}
                </span>
                {[...new Set(item.notifications)].map((message) => (
                  <span key={message}>{message}</span>
                ))}
                <details>
                  <summary>Observed prices</summary>
                  <dl>
                    {Object.entries(item.inputs).map(([feed, value]) => (
                      <div key={feed}>
                        <dt>{feed}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </>
            ) : (
              <>
                <strong>
                  {item.intent?.amount ?? item.amountIn}{" "}
                  {item.intent?.side === "buy" ? "USDC" : item.intent ? "tokens" : "raw units"}
                </strong>
                {item.reason && <span>{item.reason}</span>}
              </>
            )}
          </div>
          {"status" in item && <Status status={item.status} />}{" "}
          {"txHash" in item && item.txHash && (
            <a
              className="icon-button"
              href={`https://basescan.org/tx/${item.txHash}`}
              target="_blank"
              rel="noreferrer"
              aria-label="View transaction"
            >
              <ExternalLink size={16} />
            </a>
          )}
        </div>
      ))}
      {loading && (
        <p className="helper" role="status">
          <Loader2 size={16} className="spin" /> Loading history…
        </p>
      )}
      {page.next_page && (
        <button
          type="button"
          className="button secondary"
          disabled={loading}
          onClick={() => void load(page.next_page)}
        >
          Load earlier
        </button>
      )}
    </section>
  );
}
