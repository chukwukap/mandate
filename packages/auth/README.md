# Authentication

Privy is the selected authentication provider. The server adapter, wallet selection and eligibility policies are implemented and tested.

- `src/privy/`: server SDK adapter and access-token verification.
- `src/identity/`: Privy DID to application user mapping and linked-wallet checks.
- `src/policies/`: application authorization and eligibility.
- `src/signatures/`: application-specific signed consent where required.
- `src/sessions/`: reserved for session-related integration; do not build a second login system.

Use `@privy-io/node` on Node.js. Keep secrets and the server SDK out of web imports.
Fastify authentication hooks are assembled in `apps/api/src/app.ts`; the planned client-side PrivyProvider belongs
in `apps/web/src/providers/` and login UI in `apps/web/src/features/auth/`.

The adapter uses the pinned SDK’s `utils().auth().verifyAccessToken()` and fetches
linked accounts through `users()._get(userId)`. It does not persist access tokens.
Local token verification does not guarantee immediate logout revocation.

See [the decision and sources](../../docs/architecture/decisions/0001-privy-auth.md).
