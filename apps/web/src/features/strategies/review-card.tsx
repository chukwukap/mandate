"use client";

import { AlertTriangle, ChevronDown, Lock } from "lucide-react";
import type { Draft } from "./types";

/**
 * The last screen before a signature, built from the structured card the API already returns.
 *
 * This used to be `<pre>{draft.render_text}</pre>` — the exact bytes the signature covers, dumped
 * as a wall of monospace. That is the right thing to SIGN and the wrong thing to READ, and the
 * research on transaction review is unanimous that structured data is never self-sufficient: a
 * presentation layer has to be authored. We are in the best position to author one, because the
 * same deterministic code that renders these sections is the code whose hash folds into the
 * artifact id. Presenting `card` rather than re-describing the form means this panel physically
 * cannot drift from what was validated.
 *
 * Order matters and is taken from the review literature: what it does, then the worst case in
 * the largest type on the screen, then the things that would surprise you, then the exact bytes
 * for anyone who wants them.
 */
export function ReviewCard({
  draft,
  worstCase,
  automatic,
}: {
  draft: Draft;
  /** The single number that bounds everything, stated plainly. */
  worstCase: { total: string; expires: string } | null;
  automatic: boolean;
}) {
  const card = draft.card;
  return (
    <div className="review-card">
      {worstCase && (
        <div className="review-worst">
          <span>The most this can ever spend</span>
          <strong>{worstCase.total}</strong>
          <em>It stops on {worstCase.expires} whether or not that has been spent.</em>
        </div>
      )}

      {card?.rules?.length ? (
        <section className="review-block">
          <h4>What it does</h4>
          <ul className="review-rules">
            {card.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {card?.parameters?.length ? (
        <section className="review-block">
          <h4>Your settings</h4>
          <ul className="review-params">
            {card.parameters.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {card?.cautions?.length ? (
        <section className="review-block cautions">
          <h4>
            <AlertTriangle size={14} />
            Worth knowing
          </h4>
          <ul>
            {card.cautions.map((caution) => (
              <li key={caution}>{caution.replace(/^Caution:\s*/, "")}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        Two separate grants, named separately, because they are not the same decision. Signing
        the rule is free, off chain, and moves nothing. Approving the spend permission is the one
        that lets money leave later without the user present — and it used to appear as a
        trailing clause reading "Automatic mode needs a separate spending approval".
      */}
      <section className="review-block grants">
        <h4>
          <Lock size={14} />
          What you are authorising
        </h4>
        <ol>
          <li>
            <strong>Signing this rule.</strong> Free, off chain, and moves nothing on its own. It
            records that these are your instructions.
          </li>
          {automatic ? (
            <li>
              <strong>Approving a spending limit.</strong> A separate onchain step after this, which
              lets Mandate spend up to the limits above until they expire. You can revoke it at any
              time from your wallet.
            </li>
          ) : (
            <li>
              <strong>Nothing else.</strong> This strategy only notifies you. No money can move
              until you approve a spending limit, which this does not do.
            </li>
          )}
        </ol>
      </section>

      {/*
        The exact bytes, collapsed. `confirm_message` and not `render_text`: the wallet shows the
        authorization message, which is header lines plus the render text — so showing render_text
        here would show a substring of what is actually signed.
      */}
      <details className="review-exact">
        <summary>
          <ChevronDown size={14} />
          The exact text you will sign
        </summary>
        <pre className="signed-review">{draft.confirm_message}</pre>
      </details>
    </div>
  );
}
