# Architecture

Use a modular TypeScript workspace with explicit ownership of side effects.
Keep HTTP handlers and background job orchestration thin. Business rules live in
packages and must be callable without booting a server.

## Dependency direction

- `contracts` contains transport schemas; it must not import server packages.
- `strategy` owns deterministic strategy semantics and isolates the LLM compiler adapter.
- `database` owns SQL, transaction scopes and migrations.
- `evm` owns chain reads and transaction construction, without HTTP dependencies.
- `execution` composes strategy admission, persistence and chain integration.
- `auth` owns Privy access-token verification, verified identity mapping and eligibility policies.
  Privy manages login sessions; Mandate stores application users keyed by a unique Privy DID.
- `config` and `observability` provide shared infrastructure.
- `api` and `worker` assemble packages at their entrypoints.
- `web` imports public contracts, never database, signing or server configuration code.

## Application boundaries

API modules follow domain folders: auth, market, strategies, instances, permissions,
executions and health. Within each implemented module, keep routes, schemas and
request orchestration together. Avoid generic controller/service/repository layers
when a direct package call expresses the operation.

The worker owns market polling, evaluation scheduling, execution and recovery.
Its separation is a process boundary, not a new public trading API. A database job
must not be trusted merely because the API inserted it: the worker must revalidate
authority, expiry, asset/venue allowlists and execution limits before signing.
Database locks, unique constraints and idempotent state transitions coordinate workers.

Use PostgreSQL for durable jobs and admission records initially. Introduce Redis or
an external queue only if measured requirements justify it.

## Engineering requirements for implementation

- Strict TypeScript, runtime validation at external boundaries, structured errors.
- Decimal strings for API money values; bigint raw token units for chain calls.
- Signed review artifacts bound to immutable plans and spending limits.
- Stored permission payloads reused byte-for-byte after user approval.
- Durable transaction bytes and hashes stored before broadcast.
- Explicit tenant-scoped repositories with PostgreSQL row-level security.
- Bounded retries, graceful shutdown, readiness checks and secret-redacted logging.
- Bun unit tests, real PostgreSQL integration tests and browser end-to-end journeys.
- No implicit database migration, deployment, or live trading during startup/tests.

These directories reserve responsibilities; they are not evidence that the
requirements are already implemented.
