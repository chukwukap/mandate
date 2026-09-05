import type { AuthenticatedUser } from "@mandate/auth";

/**
 * A verified Privy identity joined to the local user row it resolves to.
 *
 * `user` is the local primary key and is the ONLY value routes may use for ownership and for
 * the tenant context. The Privy DID and the linked wallets are attributes of the identity,
 * never of the data — a wallet address arriving in a header proves nothing.
 */
export type Principal = AuthenticatedUser & { user: string };

// Written with the same inline shape as the block currently in app.ts. TypeScript only allows
// a property to be declared twice across merged interfaces when the two declarations have the
// same type, so both can coexist during the handoff window in which app.ts still carries its
// copy. Delete app.ts's block and nothing here changes.
declare module "fastify" {
  interface FastifyRequest {
    principal: (AuthenticatedUser & { user: string }) | null;
    jurisdiction: string;
    eligible: boolean;
  }
}
