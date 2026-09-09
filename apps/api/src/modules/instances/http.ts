import { selectWallet } from "@mandate/auth";
import { Problem } from "@mandate/contracts";
import type { DraftRow } from "@mandate/database";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

// These helpers are behaviourally identical to the copies in modules/strategies/routes.ts,
// modules/permissions/guards.ts and modules/market/routes.ts. `principal` and `requireEligible`
// now also exist in apps/api/src/plugins (authentication.ts exports `requirePrincipal`,
// jurisdiction.ts exports `requireEligible`), which is where all of this belongs. That directory
// is being written by another process in this same pass, so this module keeps its own copies
// rather than pinning itself to an interface that is still moving; every one of them is exported
// so this file can become a re-export shim, and then disappear, in a single edit.

export const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: "draft-7", io: "input" });

/** Swagger metadata plus the JSON-Schema mirrors of the zod contracts the handler parses. */
export function definition(tag: string, summary: string, body?: z.ZodType, params?: z.ZodType) {
  return {
    schema: {
      tags: [tag],
      summary,
      security: [{ privy: [] }],
      ...(body ? { body: json(body) } : {}),
      ...(params ? { params: json(params) } : {}),
    },
  };
}

/**
 * The authenticated owner, or 401.
 *
 * `principal(request).user` is the ONLY identifier any query in this module may be scoped by.
 * A user id read from a body or a query string is not identity, and every zod contract here is a
 * strictObject so an extra `user_id` field is a 400 rather than something a handler could reach.
 */
export function principal(request: FastifyRequest) {
  if (!request.principal) throw Problem.unauthenticated();
  return request.principal;
}

/** The linked wallet this request acts as. Throws 403/409 rather than guessing between wallets. */
export function wallet(request: FastifyRequest) {
  const header = request.headers["x-mandate-wallet"];
  return selectWallet(principal(request), typeof header === "string" ? header : undefined);
}

export function requireEligible(request: FastifyRequest) {
  if (!request.eligible)
    throw new Problem(
      403,
      "not-eligible",
      "Trading unavailable",
      "Trading is unavailable for your verified jurisdiction.",
    );
}

/**
 * The caller must be acting as the wallet that signed the draft.
 *
 * Ownership is already enforced by RLS; this is the second, narrower question of which of a
 * user's linked wallets is authorizing. Deliberately NOT applied to pause or kill: a user who
 * unlinked the signing wallet must still be able to stop a running strategy.
 */
export function requireAccount(request: FastifyRequest, draft: DraftRow) {
  if (wallet(request) !== draft.account)
    throw new Problem(
      403,
      "account-mismatch",
      "Choose the signing wallet",
      "Select the linked wallet used to sign this strategy.",
    );
}

/**
 * Runs a chain read and classifies its failure as 503, never 500 and never 400.
 *
 * `verifyMessage` returns `false` for a genuinely bad signature and *throws* when the RPC
 * transport fails. Letting the throw become a generic 500 tells the user "unexpected error" for
 * a condition that is purely "retry"; letting it become "invalid signature" is worse still,
 * because it invites the user to sign again when the stored artifact they already signed is fine.
 *
 * The error object is neither logged nor echoed: RPC client errors carry the request URL, and
 * the request URL carries the provider API key. pino's redact list covers headers and bodies,
 * not a thrown SDK object passed as a log field.
 */
export async function upstream<T>(read: () => Promise<T>, detail: string): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw Problem.unavailable(detail);
  }
}
