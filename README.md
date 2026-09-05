# Mandate — TypeScript rewrite

Node.js runs the API and worker. Bun manages workspace dependencies and tests.
Fastify provides HTTP services; Drizzle maps PostgreSQL; Next.js provides the web app.
Privy is the authentication provider; see [the auth decision](docs/architecture/decisions/0001-privy-auth.md).

**Current stage: API, worker and web workspace implemented.** Fastify/Privy authentication, signed
strategy reviews, permission lifecycle, durable evaluation, transaction journaling
and recovery run on Node.js. Run the [web workspace](apps/web/README.md) for Markets, Strategies, Activity and Settings. The worker starts
with live execution disabled; see [worker setup and limits](docs/runbooks/worker-local.md).

Browse the [documentation index](docs/README.md) and
[configuration reference](docs/reference/configuration.md).

Start with [local setup](docs/runbooks/api-local.md) and the
[API contract](docs/api/README.md). Completion checks are tracked in
[API acceptance criteria](docs/api/acceptance.md); see the
[verification record](docs/api/verification.md) for executed checks and limitations.

The original Rust implementation stays in the sibling `../mandate/` directory.

## Workspace layout

```text
mandate-node/
├── apps/
│   ├── api/                 Fastify routes, request hooks and application assembly
│   ├── worker/              Market polling, scheduling and recovery orchestration
│   └── web/                 Next.js app and feature-specific UI
├── packages/
│   ├── contracts/           Shared schemas and API transport types
│   ├── strategy/            Compiler, validation, evaluator, state machines and review
│   ├── database/            Drizzle schema, SQL migrations and scoped repositories
│   ├── evm/                 Base clients, feeds, venues, ABIs and permissions
│   ├── execution/           Admission, transaction lifecycle and reconciliation
│   ├── auth/                Privy authentication, identity mapping and eligibility policies
│   ├── config/              Typed and validated configuration
│   └── observability/       Logging, metrics and tracing
├── tests/
│   ├── integration/         API, PostgreSQL and execution integration tests
│   ├── contract/            API compatibility and chain interface tests
│   ├── e2e/                 Browser journeys
│   └── fixtures/            Deterministic strategy and chain fixtures
├── scripts/
│   ├── dev/                 Local development helpers
│   ├── database/            Migration and database maintenance commands
│   └── migration/           Explicit Rust-to-TypeScript data migration tools
├── infra/
│   ├── docker/              Local containers and build definitions
│   ├── postgres/            Database roles and initialization
│   └── monitoring/          Observability configuration
├── docs/
│   ├── architecture/        Boundaries and architecture decisions
│   ├── api/                 API contracts and documentation
│   ├── security/            Trust boundaries and permission model
│   ├── runbooks/            Operating and recovering the application
│   ├── migration/           Rewrite mapping and compatibility checklist
│   └── product/             Scope and submission demo
└── .github/workflows/       CI definitions, to be implemented
```

Each app/package has a private workspace manifest, README and TypeScript configuration.
Dependencies are pinned to the stable versions checked during scaffolding. Bun is pinned
to the installed 1.3.9 toolchain; upgrading the host runtime is a separate operation.
The workspace dependencies are recorded in `bun.lock`.

See [architecture](docs/architecture/README.md) and
[migration scope](docs/migration/README.md) for implementation boundaries.
