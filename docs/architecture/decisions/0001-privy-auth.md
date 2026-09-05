# 0001 — Use Privy for authentication

Status: accepted; server adapter and Fastify identity endpoint implemented.
Documentation reviewed: 2026-09-05.

Use `@privy-io/node` in the Node.js backend and `@privy-io/react-auth` in the
Next.js client. The Node SDK replaces the older `@privy-io/server-auth` package.
The server dependency is pinned to registry-verified `@privy-io/node@0.34.0`.
Installed types confirm `utils().auth().verifyAccessToken()` and `users()._get(id)`.
Check installed types when upgrading;
the documentation changelog alone does not establish the latest published version.

## Request flow

1. A client-side PrivyProvider manages login and its session.
2. The client obtains a current token with `getAccessToken()` and sends an
   `Authorization: Bearer ...` header to Fastify.
3. A Fastify authentication hook delegates verification to `packages/auth/src/privy`.
   Validate the signature, issuer, configured app audience and expiry using the SDK.
   Decoding a token without verification is insufficient.
4. Resolve the verified Privy DID to a unique application user. Scope database
   access to that application's user ID, never a request-supplied user ID.
5. Resolve linked wallets from verified Privy user data. An address supplied in
   request JSON is not proof that the authenticated user controls it.
6. Apply Mandate eligibility, ownership and strategy/spending authorization checks.

Return 401 for invalid or expired credentials. The client uses Privy's refresh
flow; it must not retry indefinitely. Use bounded retries for upstream requests,
redact tokens and secrets, and distinguish upstream failure from invalid credentials.

Bearer tokens are the initial transport. If cookie authentication is introduced,
design CSRF and origin checks explicitly. Do not recreate wallet-login challenges
or a parallel custom login-session system.

## Identity and trading authority

Access tokens authenticate requests. Identity tokens carry user data and have a
separate verification path: the Node SDK supports `users().get({id_token})`.
If both are used, require their verified user IDs to agree. Never pass an identity
token to an access-token verifier or trust unverified linked-account fields.

Privy login does not itself authorize trades. Mandate retains explicit signed
strategy consent and onchain spending-permission checks. A Privy embedded wallet
must not be assumed compatible with Coinbase SpendPermissionManager; verify the
actual account capabilities before offering automated execution.

Keep PRIVY_APP_SECRET server-only. Frontend configuration may contain the public
app ID. The draft database models now key users by a unique Privy DID. A draft records
its signing account separately so future wallet changes do not change its authority.

## Verification required during implementation

Cover missing/malformed/expired tokens, wrong app audience, forged signatures,
linked-wallet mismatch, cross-user access and upstream failures. Confirm local
JWT-verification behavior and logout/revocation semantics against the pinned SDK;
do not promise immediate revocation based on signature verification alone.

## Official sources

- [Node SDK setup](https://docs.privy.io/basics/nodeJS/setup)
- [Migration from server-auth](https://docs.privy.io/basics/nodeJS/advanced/migrating-from-server-auth)
- [Node SDK changelog](https://docs.privy.io/basics/nodeJS/changelog)
- [React SDK setup](https://docs.privy.io/basics/react/setup)
- [Access tokens](https://docs.privy.io/authentication/user-authentication/access-tokens)
- [Identity tokens](https://docs.privy.io/user-management/users/identity-tokens)
