# API app completion criteria

This implementation completes `apps/api` and the shared packages required to serve it.
It does not implement `apps/web`, `apps/worker`, or autonomous transaction signing.

- Node.js entrypoint, reproducible Bun install, build, start and graceful shutdown.
- Fastify request validation, stable problem responses, request IDs, logging redaction,
  secure headers, request limits, same-origin browser protections and OpenAPI documentation.
- PostgreSQL persistence through Drizzle, versioned migrations in a separate schema,
  tenant-scoped transactions and row-level security. No changes to Rust tables.
- Privy access-token verification, application-bound identity, expired/invalid token rejection,
  unique Privy DID mapping and verified linked-wallet ownership. Privy manages login sessions.
  Bearer-token transport initially; cookie transport requires explicit CSRF protection.
- Market catalogue and live read-only reference/DEX quotes, explicit unavailable prices.
- Structured and LLM-assisted strategy drafting, deterministic review, immutable stored
  artifacts, signature-bound creation, tenant-owned lists/details and lifecycle controls.
- Stable persisted spending permission preparation and signature verification, explicit
  pending-onchain status, activation only after checking the chain, and revocation calldata.
- Read-only execution/evaluation history for future worker-produced records.
- Tests for hostile input, signature tampering/replay, delayed permission signing,
  tenant isolation, database constraints, lifecycle transitions and degraded dependencies.
- Native PostgreSQL integration and Node.js HTTP smoke verification; no real transactions.
- Setup, endpoint, configuration and security documentation describing actual behavior.

An armed instance records user intent for a future worker. API responses must not imply
that market monitoring or automatic execution is running when no worker is present.

Completion evidence: [verification record](verification.md).
