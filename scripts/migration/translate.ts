import type { Asset } from "../../packages/contracts/src/index.js";
import { USDC } from "../../packages/evm/src/permissions/index.js";
import { CHAIN_ID } from "../../packages/evm/src/permissions/index.js";
import { authorizationMessage } from "../../packages/strategy/src/review/commitment.js";
import type { Caps, Envelope, Plan } from "../../packages/strategy/src/strategy.js";
import {
  capsSchema,
  digest,
  planSchema,
  review,
  validatePlan,
} from "../../packages/strategy/src/strategy.js";
import { resolveAsset, translateFeed } from "./catalogue.js";
import type { Substitution } from "./issues.js";
import { issue, Refused } from "./issues.js";
import { deterministicUuid } from "./values.js";

/** The single venue this deployment routes to. Legacy venue slugs are matched against it. */
const VENUE = "aerodrome";
/** USDC. Every legacy envelope denominated its caps in a token; only this one survives. */
const QUOTE_DECIMALS = 6;
/** Namespace for derived draft ids. Changing it re-keys every migrated draft. */
const DRAFT_NAMESPACE = "mandate/migration/draft/1";

/** A legacy envelope as its projected typed columns hold it, already decoded. */
export type LegacyEnvelope = {
  readonly id: string;
  /** Lowercase `0x` address of the token the caps are denominated in. */
  readonly spendToken: string;
  readonly spendDecimals: number;
  /** Whole units, decimal strings. Never raw integers past this point. */
  readonly perOrder: string;
  readonly perPeriod: string;
  readonly lifetime: string;
  readonly periodSecs: number;
  readonly maxOrdersPerPeriod: number;
  readonly cooldownSecs: number;
  /** ISO 8601 with an offset. */
  readonly expiresAt: string;
  /** Venue slugs in allowlist order. */
  readonly venues: readonly string[];
  /** Asset allowlist IN POSITION ORDER. The plan indexes into this; order is authority. */
  readonly assets: readonly { readonly token: string; readonly decimals: number | undefined }[];
};

/** One confirmed legacy strategy version, decoded and ready to translate. */
export type LegacyStrategy = {
  readonly userId: string;
  readonly strategyId: string;
  readonly versionId: string;
  readonly version: number;
  readonly name: string;
  /** BLAKE3 of the legacy canonical form, hex. Provenance only; not reused as an id here. */
  readonly artifactId: string;
  readonly schemaVersion: string;
  readonly planJson: unknown;
  readonly envelope: LegacyEnvelope;
  readonly confirmedAt: Date | undefined;
  readonly createdAt: Date;
  /** The mode of the instance this version was armed as, when it was ever armed. */
  readonly mode: "manual" | "auto" | undefined;
  /**
   * The account the armed instance actually spent from, when it was ever armed. Read from
   * the spend permission rather than from the wallet table: the permission is the record of
   * which wallet the user pointed this strategy at.
   */
  readonly account: string | undefined;
};

/** Exactly the `mandate_v2.drafts` columns, ready to insert. */
export type DraftRow = {
  readonly id: string;
  readonly userId: string;
  readonly account: string;
  readonly artifactId: string;
  readonly name: string;
  readonly mode: "manual" | "auto";
  readonly plan: Plan;
  readonly envelope: Envelope;
  readonly reading: string;
  readonly renderText: string;
  readonly renderHash: string;
  readonly confirmMessage: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
};

export type TranslateOptions = {
  /** The target deployment's origin. It is inside the signed text; a wrong one is unusable. */
  readonly origin: string;
  readonly now: Date;
  readonly catalogue: readonly Asset[];
  /** The `mandate_v2.users.id` the draft is attached to, which may not be the legacy id. */
  readonly userId: string;
  /** The wallet whose funds the strategy spends, lowercase `0x`. */
  readonly account: string;
  /** Substituted into every migrated envelope; legacy envelopes carried no slippage term. */
  readonly slippageBps: number;
  /** How long the migrated review stays signable. */
  readonly signingWindowMs: number;
  /** An operator-chosen replacement expiry for envelopes that have already lapsed. */
  readonly expiresAt?: string | undefined;
  /** `carry` keeps the legacy run mode; `manual` downgrades every draft. */
  readonly mode: "carry" | "manual";
};

export type TranslatedDraft = {
  readonly row: DraftRow;
  readonly substitutions: readonly Substitution[];
  /** Where this came from, for the report and the journal. */
  readonly legacy: {
    readonly versionId: string;
    readonly envelopeId: string;
    readonly artifactId: string;
    readonly schemaVersion: string;
  };
};

/**
 * Turn one confirmed legacy strategy version into an UNSIGNED `mandate_v2` draft.
 *
 * Unsigned is the whole design, and it is not a shortcut. The Rust confirmation was an
 * EIP-191 signature over a `strat/1` render hash and a BLAKE3 artifact id; this deployment
 * verifies a signature over `authorizationMessage`, whose text embeds a different origin, a
 * different artifact id and a re-rendered card. No transformation of the old signature
 * verifies against the new message, and `mandate_v2.instances.signature` is `not null`
 * precisely so that no row can claim authority without one. So a migrated strategy arrives
 * as something the user reviews and signs again, and this function's job is to make the card
 * they read faithful — not to manufacture an instance that would fail admission forever with
 * `observation-or-authority-unavailable` and no indication of why.
 *
 * Everything it cannot reproduce faithfully it refuses, and every term it had to supply it
 * records as a `Substitution`, because those are the ways the new card differs from the one
 * the user originally agreed to.
 */
export function translateStrategy(
  legacy: LegacyStrategy,
  options: TranslateOptions,
): TranslatedDraft {
  const subject = `strategy_version ${legacy.versionId}`;
  if (!legacy.confirmedAt)
    throw new Refused(
      issue(
        "strategy.unconfirmed",
        subject,
        "The version was never confirmed by a wallet signature, so there is nothing the user previously agreed to. Ask them to author it here instead.",
      ),
    );
  if (legacy.schemaVersion.toLowerCase() !== "strat/1")
    throw new Refused(
      issue(
        "plan.schema-version",
        subject,
        `The artifact declares grammar "${legacy.schemaVersion}"; only strat/1 is understood here.`,
      ),
    );

  const substitutions: Substitution[] = [];
  const envelope = translateEnvelope(legacy.envelope, options, subject, substitutions);
  const plan = translatePlan(legacy.planJson, envelope, options.catalogue, subject);

  let rendered: ReturnType<typeof review>;
  try {
    rendered = review(plan, envelope);
  } catch (error) {
    throw new Refused(
      issue(
        "plan.unrenderable",
        subject,
        `The strategy cannot be rendered as a review card here (${error instanceof Error ? error.message : "unknown reason"}). A strategy nobody can read is a strategy nobody can consent to.`,
      ),
    );
  }

  const mode = resolveMode(legacy, options, substitutions);
  const id = deterministicUuid(DRAFT_NAMESPACE, legacy.versionId, options.userId);
  // The signing deadline never outlives the authority itself: signing a card whose caps have
  // already expired produces an instance that can never admit an order.
  const capsExpiry = Date.parse(envelope.caps.expires_at);
  const expiresAt = new Date(
    Math.min(options.now.getTime() + options.signingWindowMs, capsExpiry),
  );
  substitutions.push({
    field: "draft.expires_at",
    from: "30 minutes (the interactive authoring window)",
    to: expiresAt.toISOString(),
    reason:
      "A migrated review is rendered ahead of the user rather than while they watch, so the interactive window would expire before anyone saw it.",
  });

  const name = legacy.name.slice(0, 120);
  const reading = migrationReading(legacy);
  const artifactId = digest({
    id,
    user: options.userId,
    account: options.account,
    name,
    mode,
    plan,
    envelope,
    render: rendered.render_text,
    expires: expiresAt.toISOString(),
  });
  return {
    row: {
      id,
      userId: options.userId,
      account: options.account,
      artifactId,
      name,
      mode,
      plan,
      envelope,
      reading,
      renderText: rendered.render_text,
      renderHash: rendered.render_sha256,
      confirmMessage: authorizationMessage({
        origin: options.origin,
        chainId: CHAIN_ID,
        account: options.account,
        artifact: artifactId,
        name,
        mode,
        expires: expiresAt.toISOString(),
        render: rendered.render_text,
      }),
      createdAt: options.now,
      expiresAt,
    },
    substitutions,
    legacy: {
      versionId: legacy.versionId,
      envelopeId: legacy.envelope.id,
      artifactId: legacy.artifactId,
      schemaVersion: legacy.schemaVersion,
    },
  };
}

/**
 * Rebuild the signed authority.
 *
 * Read from the legacy `envelope` table's PROJECTED COLUMNS rather than from
 * `artifact.envelope_json`. Both exist and the Rust deployment refuses to boot when they
 * disagree, but the projection is typed, its numbers are already domain-checked, and it
 * needs no knowledge of how serde rendered `Amount`, `AssetId` or `SignedDuration` in the
 * version of the code that wrote the row. Parsing the JSON would mean re-implementing a Rust
 * serialisation format from memory, on the values that decide how much money can move.
 */
function translateEnvelope(
  legacy: LegacyEnvelope,
  options: TranslateOptions,
  subject: string,
  substitutions: Substitution[],
): Envelope {
  const venues = legacy.venues.map((venue) => venue.toLowerCase());
  if (venues.length !== 1 || venues[0] !== VENUE)
    throw new Refused(
      issue(
        "envelope.venue-unsupported",
        subject,
        `The envelope allows [${legacy.venues.join(", ") || "nothing"}]; this deployment routes only to ${VENUE}, and narrowing a venue allowlist changes where the user's orders execute.`,
      ),
    );
  if (legacy.spendToken.toLowerCase() !== USDC.toLowerCase())
    throw new Refused(
      issue(
        "envelope.quote-not-usdc",
        subject,
        `The caps are denominated in ${legacy.spendToken}; every path here quotes against USDC (${USDC}) and re-denominating caps would need a price, which is the one thing enforcement must not depend on.`,
      ),
    );
  if (legacy.spendDecimals !== QUOTE_DECIMALS)
    throw new Refused(
      issue(
        "envelope.quote-scale",
        subject,
        `The envelope records ${String(legacy.spendDecimals)} decimals for USDC; it has ${String(QUOTE_DECIMALS)}. The caps derived from that row are wrong by 1e${String(Math.abs(legacy.spendDecimals - QUOTE_DECIMALS))}.`,
      ),
    );
  if (legacy.assets.length === 0)
    throw new Refused(
      issue("envelope.no-assets", subject, "The envelope allows no assets, so nothing can run."),
    );

  // Position order is authority: a plan action names `asset: 2`, never an address. Resolving
  // in order and refusing the whole strategy on any miss is the only safe handling — dropping
  // an unavailable entry would shift every later index onto a different token, and the review
  // card would render the shifted list as though it were what the user chose.
  const seen = new Set<string>();
  const assets: Asset[] = legacy.assets.map((entry, index) => {
    const token = entry.token.toLowerCase();
    if (seen.has(token))
      throw new Refused(
        issue(
          "asset.duplicate",
          subject,
          `${entry.token} appears at more than one allowlist position; the list is corrupt and its positions cannot be trusted.`,
        ),
      );
    seen.add(token);
    return resolveAsset(entry.token, entry.decimals, options.catalogue, `${subject} asset ${String(index)}`);
  });

  let expiresAt = legacy.expiresAt;
  if (Date.parse(expiresAt) <= options.now.getTime()) {
    if (!options.expiresAt)
      throw new Refused(
        issue(
          "envelope.expired",
          subject,
          `The signed authority lapsed at ${expiresAt}. Supply a replacement expiry to migrate it; the user will see the new date on the card they sign.`,
        ),
      );
    substitutions.push({
      field: "caps.expires_at",
      from: expiresAt,
      to: options.expiresAt,
      reason: "The legacy authority had already lapsed and an expiry in the past is unsignable.",
    });
    expiresAt = options.expiresAt;
  }
  substitutions.push({
    field: "caps.slippage_bps",
    from: "(absent)",
    to: String(options.slippageBps),
    reason:
      "Legacy envelopes carried no slippage term; it was chosen per order by the engine. This deployment binds it into the signed caps.",
  });

  let caps: Caps;
  try {
    caps = capsSchema.parse({
      lifetime: legacy.lifetime,
      per_order: legacy.perOrder,
      per_period: legacy.perPeriod,
      period_secs: legacy.periodSecs,
      max_orders_per_period: legacy.maxOrdersPerPeriod,
      cooldown_secs: legacy.cooldownSecs,
      expires_at: expiresAt,
      slippage_bps: options.slippageBps,
    });
  } catch (error) {
    throw new Refused(
      issue(
        "envelope.caps-invalid",
        subject,
        `The legacy caps are outside what this deployment will accept: ${error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 400) : "unknown reason"}`,
      ),
    );
  }
  return { version: "mandate/2", caps, assets, quote: USDC, venue: VENUE };
}

/**
 * Carry the plan across, rewriting only the feed URIs.
 *
 * The two grammars are the same shape — `params`/`nodes`/`machines`, the same fifteen
 * operators, the same `on_edge` / `while_true` fire modes, actions named by allowlist
 * position — so the plan is parsed rather than rewritten. That is deliberate: a hand-written
 * transpiler over trading logic is the single most dangerous thing this tool could contain,
 * because a subtle mistranslation moves real money according to a strategy nobody authored.
 * If `planSchema` refuses the legacy JSON, that is the answer; it is not an invitation to
 * patch the JSON until it parses.
 *
 * Feed URIs are the one exception, because the two deployments genuinely name feeds
 * differently and the difference is a naming convention rather than a semantic change. The
 * rewritten plan is then re-validated by `validatePlan` against the resolved asset list, so
 * a rewrite that produced an unavailable feed or an out-of-range asset index is caught here
 * rather than at the first tick.
 */
function translatePlan(
  planJson: unknown,
  envelope: Envelope,
  catalogue: readonly Asset[],
  subject: string,
): Plan {
  const parsed = planSchema.safeParse(planJson);
  if (!parsed.success)
    throw new Refused(
      issue(
        "plan.invalid",
        subject,
        `The stored plan does not satisfy this deployment's grammar: ${parsed.error.issues
          .slice(0, 4)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      ),
    );
  const rewritten: Plan = {
    ...parsed.data,
    nodes: parsed.data.nodes.map((node) => ({
      ...node,
      args: node.args.map((arg) =>
        arg.kind === "feed"
          ? { ...arg, feed: translateFeed(arg.feed, catalogue, `${subject} node ${node.id}`) }
          : arg,
      ),
    })),
  };
  try {
    return validatePlan(rewritten, envelope.assets);
  } catch (error) {
    throw new Refused(
      issue(
        "plan.invalid",
        subject,
        `The plan is well formed but not runnable here: ${error instanceof Error ? error.message : "unknown reason"}`,
      ),
    );
  }
}

/**
 * Which run mode the migrated draft requests.
 *
 * Requesting `auto` grants nothing on its own — instances always start paused and manual,
 * and automatic execution still needs a separately signed spend permission — so carrying the
 * legacy mode is not carrying authority, it is carrying an intent the user will read on the
 * card ("Requested mode: auto") before signing. Downgrading is always safe and always
 * available; upgrading never happens here.
 */
function resolveMode(
  legacy: LegacyStrategy,
  options: TranslateOptions,
  substitutions: Substitution[],
): "manual" | "auto" {
  const carried = legacy.mode ?? "manual";
  if (options.mode === "carry") return carried;
  if (carried !== "manual")
    substitutions.push({
      field: "mode",
      from: carried,
      to: "manual",
      reason: "The operator requested that every migrated strategy be re-authorised manually.",
    });
  return "manual";
}

/**
 * The plain-language line stored in `drafts.reading`.
 *
 * In the normal path this is what the authoring model understood the user to have asked for.
 * There is no such sentence for a migrated strategy, and inventing one would put words in
 * the user's mouth on the screen where they are deciding whether to sign. Saying plainly
 * where the strategy came from is both true and the thing the user most needs to know.
 */
function migrationReading(legacy: LegacyStrategy): string {
  const confirmed = legacy.confirmedAt?.toISOString() ?? "an unknown date";
  return `Migrated from your earlier Mandate strategy "${legacy.name}" (version ${String(legacy.version)}), which you confirmed on ${confirmed}. The rules below are the same; the review text, the slippage limit and the signature are new, so please read it again before signing.`;
}
