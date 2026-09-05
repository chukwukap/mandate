import { selectWallet } from "@mandate/auth";
import { Problem } from "@mandate/contracts";
import type { DraftRow } from "@mandate/database";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

// These five helpers are behaviourally identical to the copies in
// apps/api/src/modules/strategies/routes.ts. They belong in a shared apps/api/src/plugins/http.ts
// so every module shares one definition; that file does not exist yet and is outside this
// module's ownership, so this file is the local copy and should become a re-export shim — then
// be deleted — as soon as the shared plugin lands.

const json = (schema: z.ZodType) => z.toJSONSchema(schema, { target: "draft-7", io: "input" });

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
export function principal(request: FastifyRequest) {
  if (!request.principal) throw Problem.unauthenticated();
  return request.principal;
}
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
 * Runs a chain read and classifies its failure.
 *
 * Every ChainReader method used by this module is an eth_call against a contract wallet or the
 * SpendPermissionManager. viem returns `false` for a genuinely bad signature or an unapproved
 * permission, but *throws* when the transport fails. Without this the throw becomes a generic
 * 500, and — worse — the natural reading of a failed verifyPermission is "your signature is
 * invalid", which invites the user to sign again. They cannot: permissions.hash is globally
 * UNIQUE and (instance_id, token) is UNIQUE, so the prepared row can never be replaced. An RPC
 * blip must read as 503/retry.
 *
 * The upstream error object is deliberately neither logged nor echoed: RPC client errors carry
 * the request URL, which carries the provider API key.
 */
export async function upstream<T>(read: () => Promise<T>, detail: string): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Problem) throw error;
    throw Problem.unavailable(detail);
  }
}
