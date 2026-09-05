# Development workflow

Run commands from `mandate-node/`. The package manifest accepts Node `>=24 <27`
and Bun `>=1.3.9`; the recorded verification used Node 24.1.0 and Bun 1.3.9.
Put Bun on PATH, including when using a Node or Python helper that launches scripts.

## Install and run

```sh
bun install --frozen-lockfile
bun run dev:api
# In another terminal, after configuring .env.worker:
bun run dev:worker
```

These development commands use Node with tsx and watch mode. Configure the database,
Privy app and origins using [API setup](runbooks/api-local.md). The worker starts
without signing when `WORKER_EXECUTE=0`; see [worker setup](runbooks/worker-local.md).
Run `bun run dev:web` for the Next.js workspace; see [web setup](../apps/web/README.md).

## Build

```sh
bun run build:api
bun run build:worker
bun run start:api
# Separate terminal:
bun run start:worker
```

Bun bundles workspace TypeScript for Node. Third-party dependencies stay external,
so a built app still needs its installed runtime dependencies. Shared-package
runtime dependencies used by a bundle must be resolvable from that app's manifest;
verify the built Node process when adding one.

## Validate a change

```sh
bun run check:structure
bun run check:structure:web
bun run lint
bun run typecheck
bun run test:web
bun run test:api
bun run test:worker
```

`test:api` also runs shared auth, database, EVM and strategy tests. `test:worker`
runs the worker and execution-package suites. Ordinary database tests use PGlite;
the native leader-election test is skipped unless a test database is supplied.
Chain tests use deterministic fixture keys and mocked RPC. Never replace those
fixtures with a funded account.

For native PostgreSQL and built-process verification:

```sh
PG_BIN=/path/to/postgresql/bin python3 scripts/dev/test-postgres.py
```

The helper needs `initdb`, `pg_ctl`, `psql`, Python 3, Node and Bun. On the verified
macOS environment it defaults to `/opt/homebrew/opt/postgresql@17/bin`. It creates a
temporary cluster and restricted role, applies migrations, runs integration tests,
builds both apps and verifies API readiness plus worker heartbeat/shutdown through
a local RPC fixture. It removes the cluster afterward. Local socket/shared-memory
access is required.

## Where to make changes

- HTTP contracts and request handling: `apps/api` and `packages/contracts`.
- Plan validation, decimal arithmetic and evaluator semantics: `packages/strategy`.
- Admission and durable order progression: `packages/execution`.
- Worker scheduling and chain execution adapter: `apps/worker`.
- Tables, migrations, tenant queries and leadership: `packages/database`.
- Privy verification and jurisdiction policy: `packages/auth`.
- Environment validation: `packages/config`; update the matching example and reference.

Keep side-effect orchestration separate from deterministic strategy logic. Test
failure boundaries that matter: stale observations, changed authority, lost
leadership, failed commits, ambiguous receipts and partial funding. Documentation
should distinguish local verification from funded mainnet behavior and avoid
claiming Rust parity without corresponding parity evidence.
