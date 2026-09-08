"use client";

/**
 * The page-level fallback.
 *
 * Without one, a single bad field takes the whole route — a rendering error in the activity list
 * replaced the workspace with "Application error: a client-side exception has occurred", which
 * also removed the pause and stop controls, so a user could not even halt the strategy that was
 * misbehaving. A boundary keeps the failure to the page and leaves a way out of it.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset(): void;
}) {
  return (
    <div className="route-error" role="alert">
      <h2>This page didn't load</h2>
      <p>
        Your strategies and funds are unaffected — this is a display problem. Try again, and if it
        keeps happening the message below is what to report.
      </p>
      <code>{error.message || "Unknown error"}</code>
      <div className="route-error-actions">
        <button type="button" className="button" onClick={() => reset()}>
          Try again
        </button>
        <a className="button secondary" href="/">
          Back to your workspace
        </a>
      </div>
    </div>
  );
}
