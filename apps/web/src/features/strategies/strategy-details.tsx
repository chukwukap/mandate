"use client";
import { ArrowUpRight, ChevronDown, Loader2, Pause, Play } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Dialog } from "../../components/dialog";
import { Status } from "../../components/status";
import { currency, shortAddress } from "../../lib/format";
import type { WorkspaceModel } from "../../providers/use-workspace";
import { StrategyHistory } from "../executions/strategy-history";
import { SpendingPermission } from "../permissions/spending-permission";
import { type Evaluation, whyIdle } from "./why-idle";
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
  /**
   * The latest tick, so the page can say why nothing has happened.
   *
   * One row is enough and one row is the point: a recurring strategy records a cooldown refusal
   * on every tick between buys, so a list of them would be a wall of noise. What a user needs is
   * the current reason, in a sentence.
   */
  const [latest, setLatest] = useState<Evaluation | null>(null);
  const instanceId = detail?.id;
  useEffect(() => {
    if (!instanceId) return;
    let cancelled = false;
    void call<{ items: Evaluation[] }>(`/v1/instances/${instanceId}/evaluations?limit=1`)
      .then((page) => {
        if (!cancelled) setLatest(page.items[0] ?? null);
      })
      // A missing explanation is not worth an error banner over the strategy itself.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [instanceId, call]);

  if (!detail) return null;
  const idle = whyIdle(latest, detail.status);
  const content = (
    <div className="detail-content">
      <div className="detail-status">
        <Status status={detail.status} />
        <span>{detail.mode === "auto" ? "Automatic buy" : "Signal only"}</span>
      </div>
      <p className="detail-rule">
        {detail.assets?.length
          ? `Watching ${detail.assets.map((s) => s.replace("c", "")).join(", ")}`
          : "Your signed strategy"}
      </p>
      {idle && (
        <div className={`detail-idle ${idle.tone}`}>
          <strong>{idle.headline}</strong>
          {idle.action && <span>{idle.action}</span>}
        </div>
      )}
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
