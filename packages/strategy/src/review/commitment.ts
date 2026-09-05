import type { Envelope, Plan } from "../validation/schema.js";
import { digest } from "./canonical.js";

/**
 * Everything the signature binds. Field names are part of the commitment — renaming
 * one changes every artifact id — so they are fixed here rather than at each call site.
 */
export type Commitment = {
  /** Draft row id. Makes two identical strategies distinguishable artifacts. */
  id: string;
  /** Owning user id. A different user's identical strategy is a different artifact. */
  user: string;
  /** The strategy account, lowercase. */
  account: string;
  name: string;
  mode: string;
  plan: Plan;
  envelope: Envelope;
  /** `review().render_text` — the exact words shown, not a hash of them. */
  render: string;
  /** ISO 8601. A Date here would digest as `{}`; canonical() refuses one. */
  expires: string;
};

/**
 * The artifact id: sha256 over the canonical commitment.
 *
 * The plan, the envelope *and* the rendered text are all inside it, so a change to
 * the caps, the asset list, a threshold, or the words the user read all produce a
 * different id — and a signature over the old id no longer verifies.
 */
export function artifactId(commitment: Commitment): string {
  return digest(commitment);
}

export type Authorization = {
  origin: string;
  chainId: number;
  account: string;
  artifact: string;
  name: string;
  mode: string;
  /** ISO 8601 deadline for signing this draft. */
  expires: string;
  render: string;
};

/**
 * The exact text the wallet signs.
 *
 * It was hand-built in three places — the API route that creates a draft, the
 * worker's verifyCommitment, and the worker's test fixture. Signature verification
 * compares the reconstructed string to the stored one byte for byte, so a single
 * space added in one of the three would make every strategy fail admission with
 * `observation-or-authority-unavailable` and no indication of why. One definition
 * makes that class of drift impossible.
 *
 * `Origin` and `Chain` are inside the signed text so a signature collected by one
 * deployment cannot be replayed against another, or against a different chain.
 */
export function authorizationMessage(input: Authorization): string {
  return `Mandate strategy authorization\nOrigin: ${input.origin}\nChain: ${input.chainId}\nAccount: ${input.account}\nArtifact: ${input.artifact}\nName: ${input.name}\nRequested mode: ${input.mode}\nSign before: ${input.expires}\n\n${input.render}`;
}
