"use client";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import type { Page } from "../../lib/api";
import type { WorkspaceModel } from "../../providers/use-workspace";
import type { Strategy } from "./types";

export function StrategiesView({
  model,
  strategyRow,
  empty,
}: {
  model: Pick<
    WorkspaceModel,
    | "session"
    | "strategies"
    | "setStrategies"
    | "loading"
    | "setLoading"
    | "setError"
    | "strategyFilter"
    | "setStrategyFilter"
    | "nextPage"
    | "setNextPage"
    | "call"
    | "watching"
  >;
  strategyRow(strategy: Strategy, full?: boolean): ReactNode;
  empty(title: string, description: string, action?: boolean): ReactNode;
}) {
  const {
    session,
    strategies,
    setStrategies,
    loading,
    setLoading,
    setError,
    strategyFilter,
    setStrategyFilter,
    nextPage,
    setNextPage,
    call,
    watching,
  } = model;
  return (
    <>
      <div className="stat-row">
        <div>
          <span>Watching</span>
          <strong>
            {watching.length}
            <small>strategies</small>
          </strong>
        </div>
        <div>
          <span>Paused</span>
          <strong>
            {strategies.filter((s) => s.status === "paused").length}
            <small>strategies</small>
          </strong>
        </div>
        <div>
          <span>Orders recorded</span>
          <strong>
            {/* Only the rows that reported a count. One instance without it turned the whole
                figure into NaN, which is worse than a total that is quietly short. */}
            {strategies.reduce(
              (n, s) => n + (Number.isFinite(Number(s.orders)) ? Number(s.orders) : 0),
              0,
            )}
            <small>across loaded strategies</small>
          </strong>
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div className="tabs">
            {["All", "Watching", "Paused"].map((value) => (
              <button
                type="button"
                key={value}
                className={strategyFilter === value ? "active" : ""}
                onClick={() => setStrategyFilter(value)}
              >
                {value}
              </button>
            ))}
          </div>
          {/* Past the first page the number is how many are on screen, and must say so. */}
          <span className="quiet">
            {nextPage
              ? `${strategies.length} loaded · more below`
              : `${strategies.length} strategies`}
          </span>
        </div>
        {loading ? (
          <div className="loading-state">
            <Loader2 className="spin" />
            Loading your strategies
          </div>
        ) : strategies.length ? (
          <>
            <div className="strategy-table-labels">
              <span>Strategy</span>
              <span>Budget reserved</span>
              <span>Status</span>
            </div>
            {strategies
              .filter(
                (s) =>
                  strategyFilter === "All" ||
                  s.status === (strategyFilter === "Watching" ? "armed" : "paused"),
              )
              .map((s) => strategyRow(s, true))}
            {!strategies.some(
              (s) =>
                strategyFilter === "All" ||
                s.status === (strategyFilter === "Watching" ? "armed" : "paused"),
            ) && <div className="table-empty">No {strategyFilter.toLowerCase()} strategies.</div>}
          </>
        ) : (
          empty(
            session.authenticated ? "Your first rule starts here." : "Your strategies belong here.",
            session.authenticated
              ? "Pick a price. We'll keep watch."
              : "Log in to see your strategies.",
          )
        )}
        {nextPage && (
          <div className="load-more">
            <button
              type="button"
              className="button secondary"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                try {
                  const page = await call<Page<Strategy>>(
                    `/v1/instances?limit=50&before=${encodeURIComponent(nextPage.before)}&before_id=${nextPage.before_id}`,
                  );
                  setStrategies((current) => [...current, ...page.items]);
                  setNextPage(page.next_page);
                } catch {
                  setError("Couldn't load more strategies.");
                } finally {
                  setLoading(false);
                }
              }}
            >
              Load more
            </button>
          </div>
        )}
      </section>
      <p className="section-footnote">
        Budget reserved includes signals and orders that may later be cancelled or refunded.
      </p>
    </>
  );
}
