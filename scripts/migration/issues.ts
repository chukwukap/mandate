/**
 * Why a legacy row was not carried into `mandate_v2`, and what was changed about the ones
 * that were.
 *
 * These are a separate vocabulary from `@mandate/execution`'s `LimitId`. Those explain why
 * an order will not be funded; these explain why a strategy the user authored in the Rust
 * deployment cannot be reproduced here. Sharing one enum would make a migration report
 * ambiguous about whether anything was ever refused at trade time.
 *
 * The ids are stable strings so a report can be diffed between two rehearsal runs and so an
 * operator can grep for one. Adding a code is additive; renaming one breaks any tooling that
 * counts them.
 */
export type IssueCode =
  // Identity: who owns this in the new system.
  | "identity.unlinked"
  | "identity.did-invalid"
  | "identity.did-conflict"
  | "identity.account-missing"
  | "identity.account-ambiguous"
  // The signed envelope.
  | "envelope.quote-not-usdc"
  | "envelope.quote-scale"
  | "envelope.venue-unsupported"
  | "envelope.no-assets"
  | "envelope.expired"
  | "envelope.caps-invalid"
  // The asset allowlist, which the plan indexes by position.
  | "asset.not-in-catalogue"
  | "asset.decimals-disagree"
  | "asset.duplicate"
  // Feed URIs named inside the plan.
  | "feed.unknown-kind"
  | "feed.foreign-chain"
  | "feed.unknown-symbol"
  | "feed.ambiguous-symbol"
  // The plan itself.
  | "plan.schema-version"
  | "plan.invalid"
  | "plan.unrenderable"
  // The strategy record.
  | "strategy.unconfirmed";

/**
 * One refused row, or one refused part of a row.
 *
 * `subject` names the legacy primary key so an operator can go and look at it; `detail` says
 * what was wrong in words a human can act on. Both are always present — a report line that
 * says only "asset.not-in-catalogue" cannot be worked, and the whole reason this tool
 * produces a plan before it writes anything is so the refusals can be worked first.
 */
export type Issue = {
  readonly code: IssueCode;
  readonly subject: string;
  readonly detail: string;
};

export function issue(code: IssueCode, subject: string, detail: string): Issue {
  return { code, subject, detail };
}

/**
 * A term that this tool changed or supplied, on a strategy it did carry across.
 *
 * Substitutions are tracked separately from issues and never silently: the user is going to
 * be asked to sign a review card, and every field in this list is a way in which that card
 * differs from the one they signed in the Rust deployment. An operator who cannot say which
 * terms changed has no business asking anyone to sign the result.
 */
export type Substitution = {
  readonly field: "caps.slippage_bps" | "caps.expires_at" | "mode" | "draft.expires_at";
  readonly from: string;
  readonly to: string;
  readonly reason: string;
};

/** Thrown by the pure translation functions. Carries the issue so callers can collect it. */
export class Refused extends Error {
  constructor(readonly issue: Issue) {
    super(`${issue.code}: ${issue.detail}`);
    this.name = "Refused";
  }
}

/** Collect every issue a body of work raises instead of stopping at the first. */
export function collect<T>(work: () => T, issues: Issue[]): T | undefined {
  try {
    return work();
  } catch (error) {
    if (error instanceof Refused) {
      issues.push(error.issue);
      return undefined;
    }
    throw error;
  }
}
