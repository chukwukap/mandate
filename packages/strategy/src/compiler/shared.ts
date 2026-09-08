import { z } from "zod";
import { type Asset, type Plan, planSchema, validatePlan } from "../strategy.js";

/**
 * Everything a strategy compiler is, except the wire.
 *
 * The instructions, the two tools, and the validation of whatever comes back are identical for
 * every provider, and they are the part that matters: the system prompt is what stops a model
 * inventing a price, and `validatePlan` is what stops a hallucinated feed reaching a signature.
 * Keeping them here means a second provider is a transport adapter rather than a second set of
 * guardrails that can drift from the first — which is exactly how one vendor ends up safe and
 * another does not.
 */

export type Proposal = { name: string; reading: string; plan: Plan };

export interface Compiler {
  compile(prompt: string, assets: Asset[]): Promise<Proposal>;
}

/** The model asked for detail instead of inventing it. Not a failure; see the API's 422. */
export class ClarificationRequired extends Error {}

export const proposalSchema = z.strictObject({
  name: z.string().min(1).max(100),
  reading: z.string().min(1).max(2000),
  plan: planSchema,
});

export const PROPOSE_TOOL = "propose_strategy";
export const CLARIFY_TOOL = "explain_missing";

export const clarifySchema = z.object({ reason: z.string().max(2000) });

/** JSON Schema for the proposal tool, in the draft-7 shape every provider accepts. */
export function proposalJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(proposalSchema, { target: "draft-7", io: "input" }) as Record<
      string,
      unknown
    >),
    type: "object",
  };
}

export const clarifyJsonSchema = {
  type: "object",
  properties: { reason: { type: "string" } },
  required: ["reason"],
  additionalProperties: false,
} as const;

/**
 * The instructions, which are the real safety boundary.
 *
 * Every clause is load-bearing. "Never choose investments or invent prices, amounts or
 * thresholds" is the difference between a tool that writes down what the user said and one that
 * gives financial advice. The asset list and feed list are exhaustive on purpose: a model given
 * no catalogue will confidently reference `oracle:DOGE`, and while `validatePlan` catches that
 * afterwards, a refusal the user never sees is better than an error they do.
 */
export function systemPrompt(assets: Asset[]): string {
  return `Translate the user's own instructions into a reviewable strategy. Never choose investments or invent prices, amounts or thresholds. Ask for clarification by using ${CLARIFY_TOOL} when essential details are absent or unsupported. Plans use decimal strings and portfolio-scoped machines. Buys use quote or pct_equity sizes; sells use base or pct_position sizes. Never invent feed URIs. Conditions default to on_edge. while_true needs a finite max_repeats. A halt ends execution. There are no calendar, time-series, news, or technical-indicator inputs.

Do NOT implement spend or frequency limits in the plan. How much may be spent per order, per period and over the strategy's lifetime, how many orders a period allows, and the cooldown between them are all part of the signed envelope and are enforced outside the plan. A plan that counts its own fills is duplicating a limit the user already set, and usually fails validation.

The \`set\` action assigns a variable from a NODE, not from a literal: its \`value\` is the id of a node that evaluates to a number. There is no increment operator. Most strategies need no \`set\` at all — reach for it only when a later condition must compare against something computed earlier. Available assets by index: ${JSON.stringify(
    assets.map((a, i) => ({ index: i, symbol: a.symbol })),
  )}. Available feeds: ${assets.flatMap((a) => [`dex:${a.symbol}`, `oracle:${a.symbol}`]).join(", ")}.`;
}

/**
 * Turn whichever tool the model chose into a Proposal, or throw.
 *
 * Shared so a provider adapter cannot accidentally skip validation: every path into a Proposal
 * goes through `validatePlan` against the same catalogue the model was given, so a plan naming
 * an asset that does not exist is refused here rather than rendered into a card and signed.
 */
export function toProposal(name: string, input: unknown, assets: Asset[]): Proposal {
  if (name === CLARIFY_TOOL) throw new ClarificationRequired(clarifySchema.parse(input).reason);
  if (name !== PROPOSE_TOOL) throw new Error("Unexpected compiler response");
  const proposal = proposalSchema.parse(input);
  return { ...proposal, plan: validatePlan(proposal.plan, assets) };
}

/** Providers answer with a JSON string or an object depending on the API; accept both. */
export function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("The compiler returned arguments that were not JSON");
  }
}
