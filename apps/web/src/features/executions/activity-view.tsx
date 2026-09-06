"use client";
import { Activity, ArrowDownLeft, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Status } from "../../components/status";
import type { WorkspaceModel } from "../../providers/use-workspace";

export function ActivityView({
  model,
  empty,
}: {
  model: Pick<WorkspaceModel, "preview" | "executions" | "setToast" | "fetchOwned">;
  empty(title: string, description: string, action?: boolean): ReactNode;
}) {
  const { preview, executions, setToast, fetchOwned } = model;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Recent activity</h2>
        {/*
          Disabled in preview, matching StrategyHistory. The list below is a fixture there and
          fetchOwned has nothing to fetch, so an enabled button reported "Activity refreshed"
          over data that had not moved — feedback that is worse than none, because it teaches
          the reader to trust a message that is not true. The title says why rather than
          leaving a control that simply resists being pressed.
        */}
        <button
          type="button"
          className="text-button"
          disabled={preview}
          title={preview ? "Sample activity does not refresh" : undefined}
          onClick={() => {
            void fetchOwned();
            setToast("Activity refreshed");
          }}
        >
          Refresh
          <Activity size={14} />
        </button>
      </div>
      {preview ? (
        <div className="activity-list">
          {[
            {
              name: "Buy the NVIDIA dip",
              time: "Today, 10:42 AM",
              value: "$100.00",
              status: "signal",
            },
            {
              name: "A little more Apple",
              time: "Yesterday, 2:16 PM",
              value: "$50.00",
              status: "signal",
            },
            {
              name: "Buy the NVIDIA dip",
              time: "Sep 3, 11:08 AM",
              value: "$100.00",
              status: "signal",
            },
          ].map((item, i) => (
            <div className="activity-row" key={item.time}>
              <span className="activity-icon">
                <ArrowDownLeft size={20} />
              </span>
              <div>
                <strong>{item.name}</strong>
                <small>{item.time}</small>
              </div>
              <span className="number">
                {item.value}
                <small>USDC</small>
              </span>
              <Status status={item.status} />
              <span className="activity-index">0{i + 1}</span>
            </div>
          ))}
        </div>
      ) : executions.length ? (
        executions.map((item) => (
          <div className="activity-row" key={item.id}>
            <span className="activity-icon">
              <ArrowDownLeft size={20} />
            </span>
            <div>
              <strong>{item.name}</strong>
              <small>{new Date(item.createdAt).toLocaleString()}</small>
              {item.reason && <small>{item.reason}</small>}
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
      ) : (
        empty(
          "Nothing to catch up on.",
          "Signals and trades will appear here as your strategies run.",
          false,
        )
      )}
      <div className="table-footer">
        <span>Recent executions from loaded strategies</span>
        <span>Signals don't move funds</span>
      </div>
    </section>
  );
}
