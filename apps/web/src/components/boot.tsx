"use client";
import { useEffect, useState } from "react";

/**
 * The splash shown while the sign-in service resolves the session — with an exit.
 *
 * Privy's SDK fetches the app's config before it reports ready, and on a slow or blocked
 * connection that fetch aborts and never retries. Rendered as a bare spinner, that left a
 * person looking at "Opening your workspace…" for as long as they cared to wait, with no hint
 * that anything was wrong and nothing to press. After a wait no healthy connection needs, the
 * splash says what it is waiting on and offers the one thing that helps.
 */
export function Boot({ stalledAfterMs = 12_000 }: { stalledAfterMs?: number }) {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setStalled(true), stalledAfterMs);
    return () => clearTimeout(timer);
  }, [stalledAfterMs]);
  return (
    <div className="boot" role="status">
      <span className="brand-mark">m</span>
      <span>
        {stalled ? "Still connecting to the sign-in service…" : "Opening your workspace…"}
      </span>
      {stalled && (
        <p className="boot-stalled">
          This is taking longer than it should. Check your connection, then try again.
          <button
            type="button"
            className="button secondary"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
        </p>
      )}
    </div>
  );
}
