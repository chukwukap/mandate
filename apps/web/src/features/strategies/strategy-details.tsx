"use client";
import { ArrowUpRight, ChevronDown, Loader2, Pause, Play } from "lucide-react";
import Link from "next/link";
import { Dialog } from "../../components/dialog";
import { Status } from "../../components/status";
import { currency, shortAddress } from "../../lib/format";
import type { WorkspaceModel } from "../../providers/use-workspace";
import { StrategyHistory } from "../executions/strategy-history";
import { SpendingPermission } from "../permissions/spending-permission";
export function StrategyDetails({
  model,
}: {
  model: Pick<
    WorkspaceModel,
    | "detail"
    | "call"
    | "session"
    | "fetchOwned"
    | "openDetail"
    | "error"
    | "setError"
    | "busy"
    | "setDetail"
    | "router"
    | "changeStatus"
    | "detailPage"
  >;
}) {
  const {
    detail,
    call,
    session,
    fetchOwned,
    openDetail,
    error,
    setError,
    busy,
    setDetail,
    router,
    changeStatus,
    detailPage,
  } = model;
  if (!detail) return null;
  const content = (
    <div className="detail-content">
      <div className="detail-status">
        <Status status={detail.status} />
        <span>{detail.mode === "auto" ? "Automatic buy" : "Signal only"}</span>
      </div>
      <p className="detail-rule">{detail.rule ?? "Your signed strategy"}</p>
      <div className="detail-metrics">
        <div>
          <small>Budget reserved</small>
          <strong>{currency(detail.spent)}</strong>
        </div>
        <div>
          <small>Total budget</small>
          <strong>{currency(detail.lifetime)}</strong>
        </div>
        <div>
          <small>Orders</small>
          <strong>{detail.orders}</strong>
        </div>
      </div>
      {detail.account && (
        <div className="setting-row">
          <span>Signing wallet</span>
          <span className="number">{shortAddress(detail.account)}</span>
        </div>
      )}
      {detail.render_text && (
        <details className="review-details">
          <summary>
            Signed review
            <ChevronDown size={16} />
          </summary>
          <pre>{detail.render_text}</pre>
        </details>
      )}
      {detail.requested_mode === "auto" && !["halted", "ended"].includes(detail.status) && (
        <SpendingPermission
          instance={detail.id}
          call={call}
          sign={session.signPermission}
          send={session.sendPermission}
          onChange={() => {
            void fetchOwned();
            void openDetail(detail);
          }}
        />
      )}
      <StrategyHistory instance={detail.id} call={call} />
      {detail.halt_reason && <p className="helper">{detail.halt_reason}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="helper">Pausing stops new work. Existing transactions can still settle.</p>
      {!["halted", "ended"].includes(detail.status) && (
        <details className="review-details stop-control">
          <summary>Stop this strategy permanently</summary>
          <p className="helper">
            This cannot be restarted. Existing transactions can still settle, and spending
            permission must be revoked separately.
          </p>
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => changeStatus(detail, "kill")}
          >
            Confirm permanent stop
          </button>
        </details>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            setDetail(null);
            router.push("/activity");
          }}
        >
          View activity
          <ArrowUpRight size={15} />
        </button>
        {!["halted", "ended"].includes(detail.status) && (
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => changeStatus(detail, detail.status === "armed" ? "pause" : "arm")}
          >
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : detail.status === "armed" ? (
              <Pause size={16} />
            ) : (
              <Play size={16} />
            )}{" "}
            {detail.status === "armed" ? "Pause strategy" : "Start watching"}
          </button>
        )}
      </div>
    </div>
  );
  if (detailPage)
    return (
      <section className="panel strategy-detail-page">
        <Link className="text-button" href={"/strategies"}>
          ← All strategies
        </Link>
        {content}
      </section>
    );
  return (
    <Dialog
      title={detail.name}
      eyebrow="STRATEGY DETAILS"
      onClose={() => {
        setDetail(null);
        setError("");
      }}
    >
      <Link className="text-button detail-page-link" href={`/strategies/${detail.id}`}>
        Open strategy page
        <ArrowUpRight size={14} />
      </Link>
      {content}
    </Dialog>
  );
}
