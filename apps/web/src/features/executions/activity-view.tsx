"use client";
import { Activity, ArrowDownLeft, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Status } from "../../components/status";
import type { WorkspaceModel } from "../../providers/use-workspace";
import { reasonText } from "./types";

export function ActivityView({
  model,
  empty,
}: {
  model: Pick<WorkspaceModel, "executions" | "setToast" | "fetchOwned" | "session">;
  empty(title: string, description: string, action?: boolean): ReactNode;
}) {
  const { executions, setToast, fetchOwned, session } = model;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Recent activity</h2>
        {/*
          Gated on the session, not on a demo flag. `fetchOwned` returns immediately without a
          request when nobody is signed in, so an enabled button reported "Activity refreshed"
          over data that had not moved — feedback worse than none, because it teaches the reader
          to trust a message that is not true. The title says why rather than leaving a control
          that simply resists being pressed.
        */}
        <button
          type="button"
          className="text-button"
          disabled={!session.authenticated}
          title={session.authenticated ? undefined : "Log in to load your activity"}
          onClick={() => {
            void fetchOwned();
            setToast("Activity refreshed");
          }}
        >
          Refresh
          <Activity size={14} />
        </button>
      </div>
      {executions.length
        ? executions.map((item) => (
            <div className="activity-row" key={item.id}>
              <span className="activity-icon">
                <ArrowDownLeft size={20} />
              </span>
              <div>
                <strong>{item.name}</strong>
                <small>{new Date(item.createdAt).toLocaleString()}</small>
                {item.reason && <small>{reasonText(item.reason)}</small>}
              </div>
              <span className="number">
                {item.intent?.amount ?? item.amountIn}
                <small>
                  {item.intent ? (item.intent.side === "buy" ? "USDC" : "tokens") : "raw units"}
                </small>
              </span>
              <Status status={item.status} />
              {item.txHash && (
                <a
                  href={`https://basescan.org/tx/${item.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="icon-button"
                  aria-label="View transaction"
                >
                  <ExternalLink size={16} />
                </a>
              )}
            </div>
          ))
        : empty(
            "Nothing to catch up on.",
            "Signals and trades will appear here as your strategies run.",
            false,
          )}
      <div className="table-footer">
        <span>Recent executions from loaded strategies</span>
        <span>Signals don't move funds</span>
      </div>
    </section>
  );
}
