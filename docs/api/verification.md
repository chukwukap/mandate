# API completion verification

Verified on 2026-09-05. Scope: `apps/api` and the shared packages it uses.
Web, worker, transaction execution and Rust-data migration are outside this app.

| Requirement | Evidence |
| --- | --- |
| Reproducible Node/Bun build | Clean temporary copy: frozen-lockfile install, typecheck and API build all passed. The copy was removed afterward. |
| HTTP validation, auth boundary, headers and problems | `apps/api/test/http.test.ts` checks missing auth, identity resolution, spoofed geography, origins, preflight, secret-safe errors, request IDs, readiness and OpenAPI. |
| Privy verification and linked wallets | `packages/auth/test/auth.test.ts` uses the real SDK with cryptographically signed fixtures, including forgery, expiry, wrong audience/issuer, missing claims, linked-wallet mismatch and upstream failures. |
| Durable isolated persistence | Versioned Drizzle migrations target mandate_v2 with separate migration bookkeeping. `packages/database/test/schema.test.ts` verifies forced RLS, cross-tenant denial, immutable reviews, consumed drafts and unique Privy identity. |
| Authoring and signatures | Strategy/compiler tests exercise exact decimal quantities, deterministic commitments, invalid graphs, SDK tool output, clarification and upstream errors. API integration verifies exact signatures and single-use drafts. |
| Spending permissions | API integration verifies stable payloads across a simulated two-minute delay, rejects altered timestamps, requires observed onchain approval, and distinguishes local pause from confirmed revocation. |
| Lifecycle and history | API integration covers owned reads, cross-user denial, terminal state protection, empty execution history and pagination across identical timestamps. |
| Market adapter | EVM tests verify buy/reverse-sell raw units, best route selection, stale/missing references, price bands, malformed amounts, wrong network, cache coalescing and bounded request pacing. |
| Native PostgreSQL and real Node HTTP | `scripts/dev/test-postgres.py` passed seven API integration tests with a NOSUPERUSER/NOBYPASSRLS role, built the server, then checked actual HTTP liveness, PostgreSQL readiness, missing-auth rejection and graceful shutdown. Its temporary cluster was stopped and removed. |
| Live read-only integration | Base mainnet reference reads succeeded. A 10-USDC NVDAc quote succeeded on tick spacing 10 through an alternate public RPC. Local EIP-712 hashing matched deployed SpendPermissionManager.getHash; approval/revocation reads returned false for an unsigned fixture. No transaction was signed or broadcast in these live checks. |
| Documentation | `docs/api/README.md`, `docs/runbooks/api-local.md`, `docs/security/api.md` and the Privy architecture decision describe setup, endpoints, configuration, authority and operational limits. |
| Original app and next apps | The sibling Rust app's Git status is clean. Web and worker have no implemented entrypoints and remain scaffolds. |

The ordinary API suite passes **46 tests**, with zero failures. Biome and strict
TypeScript checks pass. Native tests are a separate run of the seven API integration
cases, not seven additional unique cases.

Operational boundaries: configure your own Privy app credentials and restricted
PostgreSQL role before use. Actual Privy browser login requires the later client.
Public Base RPCs can throttle calls; missing observations are explicitly null.
Automatic sell authority is not supported by this API version. A saved/armed
instance does not run trades: `execution_available` remains false until a future
worker is implemented and verified independently.
