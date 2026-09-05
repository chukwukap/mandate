import { addressSchema, type Hex, Problem } from "@mandate/contracts";
import { hashTypedData } from "viem";

/**
 * The EIP-712 form of the strategy review card.
 *
 * `@mandate/strategy` already defines the plaintext form (`authorizationMessage`) and the
 * artifact commitment (`artifactId`). This module deliberately does not reimplement either: the
 * input type below carries **exactly** the fields of `Authorization` from that package, under the
 * same names, so one object can be handed to both encoders and the two can never drift apart.
 *
 * Why a second encoding at all. `personal_sign` shows the user a wall of text and gives a
 * contract nothing structured to check; `eth_signTypedData_v4` renders named fields, and Base
 * Account — a smart wallet — displays them. The tradeoff is that a wallet showing only
 * `artifact: 0x9f3c…` is blind signing, which is why the rendered review text is carried inside
 * the struct as a `string` rather than only as part of the hash. The user reads the words; the
 * `artifact` digest binds everything the words cannot show (the compiled plan, the envelope, the
 * caps, the asset list).
 */

/** EIP-712 domain name. Part of the domain separator: changing it invalidates every signature. */
export const DOMAIN_NAME = "Mandate";
/** Domain version. Bump only alongside a deliberate re-signing migration. */
export const DOMAIN_VERSION = "2";

/**
 * The strategy authorization, field-for-field identical to `@mandate/strategy`'s `Authorization`.
 *
 * `artifact` is the 64-character lowercase sha256 hex that `artifactId()` returns, without a
 * `0x` prefix — the same string the `drafts.artifact_id` column and the `/v1/strategies` response
 * carry. It is widened to `bytes32` for the typed data here, in one place.
 */
export type StrategyAuthorization = {
  readonly origin: string;
  readonly chainId: number;
  readonly account: string;
  readonly artifact: string;
  readonly name: string;
  readonly mode: string;
  /** ISO 8601 in `Date.toISOString()` form. Deadline for *signing*, not for executing. */
  readonly expires: string;
  /** `review().render_text` — the exact words shown on the card. */
  readonly render: string;
};

/**
 * The EIP-712 type table.
 *
 * Two things here are load-bearing and must not be tidied:
 *
 * - **Field order is part of the type hash.** `encodeType` joins the members in declaration
 *   order, so swapping two lines changes every digest ever produced and silently invalidates
 *   every stored signature. The order chosen puts what the user needs to read first, because
 *   that is the order a wallet renders them in.
 * - **`EIP712Domain` is not in this table.** viem derives it from whichever domain fields are
 *   populated, and declaring it here would force `chainId` to be typed as the `bigint` its
 *   `uint256` implies — which is not JSON-serialisable and would need the `permissionJson`-style
 *   twin that this struct otherwise avoids. The wire form that raw `eth_signTypedData_v4`
 *   callers need is `strategyAuthorizationJson` below, and a test asserts the two hash alike.
 */
export const strategyAuthorizationTypes = {
  StrategyAuthorization: [
    { name: "name", type: "string" },
    { name: "mode", type: "string" },
    { name: "review", type: "string" },
    { name: "account", type: "address" },
    { name: "origin", type: "string" },
    { name: "expires", type: "string" },
    { name: "artifact", type: "bytes32" },
  ],
} as const;

export const PRIMARY_TYPE = "StrategyAuthorization" as const;

/**
 * The domain type table, in viem's canonical member order, listing exactly the domain fields
 * `strategyAuthorizationTypedData` populates — no `verifyingContract`, because there is no
 * Mandate contract and naming one that does not exist would be a lie a wallet displays.
 *
 * Cross-deployment replay is stopped by `origin` inside the struct instead of by a domain `salt`.
 * Both bind equally, and `origin` has the property that matters here: it is a field the wallet
 * shows the user, so a prompt from someone else's deployment is visibly from someone else's
 * deployment rather than a byte of entropy nobody can read.
 */
export const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
] as const;

/** Matches `drafts.artifact_id` and the `artifact_id` route input: sha256, lowercase, no 0x. */
const ARTIFACT = /^[0-9a-f]{64}$/;

/**
 * Ceilings, not aesthetics.
 *
 * Every one of these strings is keccak-hashed and, for `render`, shown to a wallet. The API
 * bounds them on the way in (`name` at 100 characters, the plan at 4000), but this module is also
 * called by the worker against rows written months ago and by tests against hand-built cards, so
 * it does its own bounding rather than trusting an upstream check it cannot see. The values are
 * comfortably above anything the system produces; they exist so an oversized row cannot turn a
 * verification into unbounded hashing work.
 */
const LIMITS = { origin: 512, account: 42, name: 256, mode: 32, expires: 64, render: 65_536 };

/** Constructed rather than written as a literal: a raw NUL in a source file is invisible. */
const NUL = String.fromCharCode(0);

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Problem(
      400,
      "invalid-authorization",
      "Invalid strategy authorization",
      `The strategy authorization field '${field}' is missing or out of range.`,
    );
  // Postgres `text` cannot hold a NUL, so a card containing one could never round-trip through
  // the database it will be re-verified against. Refusing it here keeps the signed form and the
  // storable form the same set of values.
  if (value.includes(NUL))
    throw new Problem(
      400,
      "invalid-authorization",
      "Invalid strategy authorization",
      `The strategy authorization field '${field}' contains an unsupported character.`,
    );
  return value;
}

/**
 * The normalised card: everything checked, everything in the exact shape the encoder needs.
 *
 * `account` is lowercased because that is the form the `draft_account_valid` check constraint
 * stores. Casing does not affect the digest — an `address` member encodes as 20 bytes — but it
 * does affect the field-by-field comparison below, and having exactly one normal form there is
 * what makes that comparison trustworthy.
 */
export type NormalizedAuthorization = {
  readonly origin: string;
  readonly chainId: number;
  readonly account: Hex;
  /** 0x-prefixed, lowercase. The `bytes32` widening of `artifact`. */
  readonly artifact: Hex;
  readonly name: string;
  readonly mode: string;
  readonly expires: string;
  readonly render: string;
};

/**
 * Validate and normalise a card, or throw.
 *
 * The `expires` check deserves its reason spelled out: it insists on the exact
 * `Date.toISOString()` form rather than merely a parseable date. `2026-01-01T00:00:00Z` and
 * `2026-01-01T00:00:00.000Z` are the same instant and two different digests, and the artifact
 * commitment upstream already hashes `expiresAt.toISOString()`. Requiring the canonical spelling
 * makes the string and the instant one-to-one, so "the same deadline" can never mean two
 * signatures.
 */
export function parseAuthorization(input: StrategyAuthorization): NormalizedAuthorization {
  const account = addressSchema.safeParse(input.account);
  if (!account.success)
    throw new Problem(
      400,
      "invalid-authorization",
      "Invalid strategy authorization",
      "The strategy authorization account is not an Ethereum address.",
    );
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0)
    throw new Problem(
      400,
      "invalid-authorization",
      "Invalid strategy authorization",
      "The strategy authorization chain id is not a chain.",
    );
  const artifact = text(input.artifact, "artifact", 64);
  if (!ARTIFACT.test(artifact))
    throw new Problem(
      400,
      "invalid-authorization",
      "Invalid strategy authorization",
      "The strategy authorization artifact is not a sha256 commitment.",
    );
  const expires = text(input.expires, "expires", LIMITS.expires);
  const at = Date.parse(expires);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== expires)
    throw new Problem(
      400,
      "invalid-authorization",
      "Invalid strategy authorization",
      "The strategy authorization deadline is not a canonical ISO 8601 instant.",
    );
  return {
    origin: text(input.origin, "origin", LIMITS.origin),
    chainId: input.chainId,
    account: account.data.toLowerCase() as Hex,
    artifact: `0x${artifact}`,
    name: text(input.name, "name", LIMITS.name),
    mode: text(input.mode, "mode", LIMITS.mode),
    expires,
    render: text(input.render, "render", LIMITS.render),
  };
}

/**
 * The EIP-712 payload a wallet signs, and the API returns verbatim.
 *
 * Every value is JSON-safe — there is no `bigint` anywhere in the struct, which is why this has
 * no `permissionJson`-style twin. `chainId` is a `number` and viem widens it to `uint256`.
 *
 * `message.review` is `input.render`. The struct member is named for what the user is looking at;
 * the input field is named for the function that produced it. This is the only place the two
 * names meet.
 */
export function strategyAuthorizationTypedData(input: StrategyAuthorization) {
  const card = parseAuthorization(input);
  return {
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId: card.chainId },
    types: strategyAuthorizationTypes,
    primaryType: PRIMARY_TYPE,
    message: {
      name: card.name,
      mode: card.mode,
      review: card.render,
      account: card.account,
      origin: card.origin,
      expires: card.expires,
      artifact: card.artifact,
    },
  } as const;
}

/** The digest a signature must cover. */
export function strategyAuthorizationHash(input: StrategyAuthorization): Hex {
  return hashTypedData(strategyAuthorizationTypedData(input));
}

/**
 * The same payload with `EIP712Domain` spelled out, for a client that hands it to
 * `eth_signTypedData_v4` as JSON rather than through viem.
 *
 * The distinction is not cosmetic: viem's `signTypedData` fills the domain table in itself, but
 * `provider.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(data)] })`
 * — which is how this app's wallet bridge signs — hands the object across verbatim, and MetaMask
 * rejects a payload whose `types` has no `EIP712Domain`. Serving one form and hashing the other
 * would be a drift risk, so a test asserts both produce the same digest.
 */
export function strategyAuthorizationJson(input: StrategyAuthorization) {
  const typed = strategyAuthorizationTypedData(input);
  return { ...typed, types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...typed.types } } as const;
}

/** Every field inside the signed struct, plus the two that reach it through the domain. */
export const AUTHORIZATION_FIELDS = [
  "origin",
  "chainId",
  "account",
  "artifact",
  "name",
  "mode",
  "expires",
  "render",
] as const;

/**
 * Which fields differ between the card that was signed and the card that would run.
 *
 * Returns field names only. The values are never included anywhere they could be logged or sent
 * to a client: `render` is the whole strategy in prose and `artifact` identifies a user's private
 * plan, and a diff is produced precisely when something is already wrong, which is the worst
 * moment to start emitting them.
 */
export function authorizationDifferences(
  signed: StrategyAuthorization,
  executing: StrategyAuthorization,
): string[] {
  const a = parseAuthorization(signed);
  const b = parseAuthorization(executing);
  // Compared value by value rather than by comparing the two digests. A digest comparison answers
  // "are these the same?" and nothing else; when the answer is no, an operator needs to know
  // whether the caps moved or a word in the review text changed, and a 32-byte difference cannot
  // tell them. The digest is still what the signature is checked against.
  return AUTHORIZATION_FIELDS.filter((field) => a[field] !== b[field]);
}

/**
 * The consent boundary.
 *
 * `signed` is the card as it was recorded when the user signed it; `executing` is the card
 * rebuilt from the rows that are about to run. They come from different places on purpose — one
 * from stored strings, one re-derived from the plan and envelope — so agreement between them is
 * evidence rather than a tautology. If they differ by one character of review text, one basis
 * point of a cap, or one asset, the user did not agree to what is about to run.
 *
 * A 409 rather than a 400: nothing about the *request* is malformed, the artifact underneath it
 * moved, and the fix is to review and sign again.
 */
export function assertSameAuthorization(
  signed: StrategyAuthorization,
  executing: StrategyAuthorization,
): void {
  const changed = authorizationDifferences(signed, executing);
  if (changed.length === 0) return;
  throw new Problem(
    409,
    "authorization-mismatch",
    "Strategy changed",
    `The strategy that would run differs from the one you signed (${changed.join(", ")}). Review and sign again.`,
  );
}

/**
 * Has the signing deadline passed?
 *
 * Deliberately separate from verification, and deliberately not called by it. `expires` bounds
 * how long a *draft* may sit unsigned; the signature it produces stays valid for the life of the
 * instance, and the worker re-verifies that same signature on every tick — weeks later, long past
 * this instant. Folding the deadline into verification would halt every live strategy the moment
 * its draft window closed. The submission route is the one place that should ask.
 */
export function signingDeadlinePassed(input: StrategyAuthorization, now: number): boolean {
  return Date.parse(parseAuthorization(input).expires) <= now;
}
