# Running the API locally

Prerequisites: Node.js 24+, Bun 1.3.9+ on PATH, PostgreSQL 17+, and a Privy app.
The lockfile pins dependencies. Run commands from `mandate-node/`.

```sh
bun install --frozen-lockfile --ignore-scripts
cp .env.example .env
```

Set PRIVY_APP_ID, PRIVY_APP_SECRET and APP_ORIGIN. The frontend's public app ID
must match the backend app. Never put the app secret in NEXT_PUBLIC variables.
Set DATABASE_URL to the restricted application role. Set MIGRATION_DATABASE_URL
to a separate owner role for explicit migrations; no migration runs at server startup.

The migration command creates only `mandate_v2` and `mandate_migrations`. It does
not import or change the Rust application's data. Prefer a separate development
database and review the connection target before applying migrations.

```sh
bun run db:migrate
```

As the database administrator, grant the application role access after migration:

```sql
CREATE ROLE mandate LOGIN NOSUPERUSER NOBYPASSRLS;
-- Set its password through your administrator's secure credential process.
GRANT USAGE ON SCHEMA mandate_v2 TO mandate;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mandate_v2 TO mandate;
```

The app must not use a superuser/BYPASSRLS role; readiness rejects it. Future schema
changes need corresponding grants. Tenant transactions set their own user context,
and all tenant tables force row-level security.

```sh
bun run dev:api
# Or build and run the Node bundle:
bun run build:api
bun run start:api
```

Default listen address is 127.0.0.1:8080. Set API_DOCS=1 for `/openapi.json`.
`/health` is liveness; `/ready` also checks database schema/role and Base RPC.
SIGINT/SIGTERM closes HTTP and the database pool, with a 15-second shutdown deadline.
A ready API does not imply a worker exists or trading is running.

Optional configuration:

- ANTHROPIC_API_KEY and ANTHROPIC_MODEL together enable text authoring.
- SPENDER_ADDRESS is a public worker address used in permission preparation. The
  API requires no spender private key and never submits a transaction.
- ELIGIBLE_COUNTRIES is an explicit allowlist; empty disables trading operations.
- TRUSTED_PROXY_IPS contains exact ingress IPs. Only trust cf-ipcountry when the
  ingress overwrites it and direct access is blocked.
- DEV_COUNTRY is for local development only; it is ignored in production.
- BASE_RPC_URL configures read-only Base access; public RPC capacity is limited.

Verification:

```sh
bun run lint
bun run typecheck
bun run test:api
PG_BIN=/path/to/postgresql/bin python3 scripts/dev/test-postgres.py
```

The native test script creates and removes its own temporary cluster, runs real
API/worker/database integration with a restricted role, builds both apps, and checks
Node startup, heartbeat, HTTP readiness and graceful shutdown against a local RPC fixture. It requires
permission to use PostgreSQL shared memory and local sockets. Ordinary tests use
PGlite for database integration and deterministic chain fixtures. No tests broadcast
real transactions; live Privy login requires your configured app and client.

See [security boundaries](../security/api.md) before connecting real accounts.
