"use client";

/**
 * The last resort, for a failure in the root layout itself.
 *
 * This one has to render its own <html> and <body>: it replaces the layout rather than sitting
 * inside it, so none of the app's providers or styles are available here. Everything is inline
 * for that reason.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset(): void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#0f1115",
          color: "#e6e9ee",
        }}
      >
        <main style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 500 }}>Mandate couldn't start</h1>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: "#9aa3b2" }}>
            Your strategies and funds are unaffected. Reload to try again.
          </p>
          {/* The digest is Next's own id for the failure and the only thing worth quoting in a
              report; the message itself is minified in production and says nothing useful. */}
          {error.digest && (
            <code style={{ fontSize: 10, color: "#6b7480" }}>ref {error.digest}</code>
          )}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: 12,
              padding: "9px 16px",
              borderRadius: 8,
              border: "1px solid #2a3240",
              background: "#171b21",
              color: "#e6e9ee",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
