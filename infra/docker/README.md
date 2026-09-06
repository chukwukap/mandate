# Containers

| File | What it is for |
| --- | --- |
| `compose.yaml` | Local development PostgreSQL 17 on `127.0.0.1:55432`, with the roles from `infra/postgres` already created. |
| `initdb/02-dev-passwords.sh` | First-boot wrapper that runs `infra/postgres/02-dev-passwords.sh` inside the container. |
| `apply-grants.sh` | Applies `03-grants.sql` and `04-metrics.sql` after `bun run db:migrate`. Re-run it after every migration. |
| `api.Dockerfile` | Production image for the Fastify API. Bun installs and bundles, Node runs. |
| `worker.Dockerfile` | Production image for the worker. Same shape, different closure and no listener. |
| `*.Dockerfile.dockerignore` | Per-image build-context filters. BuildKit reads these in preference to a root `.dockerignore`. |

Nothing here builds or runs the web app; `apps/web/README.md` covers that.

## Local development

Run from the repository root.

```sh
docker compose -f infra/docker/compose.yaml up -d
cp .env.example .env
```

`.env.example` already points `DATABASE_URL` at this container
(`postgres://mandate:mandate@localhost:55432/mandate`). Add the owner role, which the
application must never use:

```sh
MIGRATION_DATABASE_URL=postgres://mandate_owner:mandate_owner@localhost:55432/mandate
```

Then create the schema and hand out privileges:

```sh
bun run db:migrate            # runs as mandate_owner, creates mandate_v2
infra/docker/apply-grants.sh  # least-privilege grants + the metrics functions
bun run dev:api               # and, in another shell, bun run dev:worker
```

`bun run dev:worker` reads `.env.worker`, which is a separate file with its own role
(`mandate_worker`, password `mandate_worker` in this container) — the worker is the only process
allowed to write the transaction journal, and the API is the only one allowed to create users
and permissions. Point it at port **55432**, not 5432.

### Four roles, and why the compose file is about them

`01-roles.sql` creates `mandate_owner` (owns the schema, used only by `db:migrate`), `mandate`
(the API), `mandate_worker` and `mandate_metrics`. All four are `NOSUPERUSER NOBYPASSRLS`.

Handing the application `postgres://postgres:postgres@…` would start faster and would disable
the tenant boundary completely: row-level security does not apply to a superuser or to a
`BYPASSRLS` role, so every user's strategies, permissions and executions would be visible to
every query — and it would look fine, because the API's own filters would still be in place.
`databaseReady()` refuses to report ready on such a connection, which is why a superuser URL
fails at `/ready` rather than in a support ticket.

### Operating notes

- The init scripts run **once**, when the data directory is empty. To re-run them (a change to
  `01-roles.sql`, a password change): `docker compose -f infra/docker/compose.yaml down -v`,
  then `up -d` and migrate again. `down` without `-v` keeps the volume and skips them.
- `03-grants.sql` and `04-metrics.sql` are deliberately *not* mounted into
  `/docker-entrypoint-initdb.d`. They grant on tables that only exist after the migration, and
  03 raises when one is missing — which during first-boot init would abort the entrypoint and
  leave a data directory that never re-runs its init files.
- The healthcheck goes over TCP (`pg_isready -h 127.0.0.1`) rather than the unix socket,
  because during initialisation the entrypoint runs a temporary server with
  `listen_addresses=''`. A socket check reports healthy while the roles are still being created.
- Passwords come from the environment. Override any of `MANDATE_OWNER_PASSWORD`,
  `MANDATE_APP_PASSWORD`, `MANDATE_WORKER_PASSWORD`, `MANDATE_METRICS_PASSWORD`,
  `POSTGRES_SUPERUSER_PASSWORD` before `up`, and update `.env` to match.
- psql without leaving the terminal:
  `docker compose -f infra/docker/compose.yaml exec postgres psql -U postgres -d mandate`.

## Production images

```sh
docker build -f infra/docker/api.Dockerfile    -t mandate-api:local    .
docker build -f infra/docker/worker.Dockerfile -t mandate-worker:local .
```

The context is the repository root (the trailing `.`) because both bundles pull in `packages/*`.

Both images are three stages on top of a source-sanitising one: `bun install --production
--frozen-lockfile --filter ./apps/<app>`, then the repository's own `bun run build:<app>`, then
a `node:24-alpine` runtime that receives only `node_modules`, the built bundle and the
`package.json` that marks it ESM. The application files stay root-owned and the process runs as
the unprivileged `node` user, so it can read its own bundle and not rewrite it.

`--filter` is doing real work: the unfiltered workspace install is 1.8 GB — it includes Next,
React, wagmi and the wallet SDKs — against 240 MB for the API's closure and 181 MB for the
worker's. Both then drop `@electric-sql/pglite` and `typescript`, which come back as *optional
peer* dependencies of `drizzle-orm` and `@solana/*` despite `--production` and are never imported
at runtime. Built here, that lands at 278 MB for the API image (187 MB of it `node_modules`) and
240 MB for the worker.

Run them with configuration from the environment; no image layer contains a secret.

```sh
docker run --rm --env-file .env -p 8080:8080 --stop-timeout 20 mandate-api:local
docker run --rm --env-file .env.worker --stop-timeout 40 mandate-worker:local
```

- `NODE_ENV=production` is baked in, and `packages/config` then **rejects a non-HTTPS
  `APP_ORIGIN`**. A local run against `http://localhost:3000` needs `NODE_ENV=development`.
- `HOST=0.0.0.0` is baked into the API image. The config default of `127.0.0.1` is right on a
  laptop and unreachable inside a container.
- The stop timeouts are not decoration. The API gives itself 15 s to drain HTTP and close the
  pool; the worker gives itself 30 s to abort its cycle and release the leadership lease. The
  daemon's default is a 10 s SIGKILL, which truncates both — and for the worker that means the
  next process waits for the lease to expire instead of taking over.
- `DATABASE_URL` inside a container is not `localhost`. Against the compose database on Docker
  Desktop, use `host.docker.internal:55432`.
- The API image has a `HEALTHCHECK` on `/health` (liveness). Point orchestrator *readiness* at
  `/ready`, which also checks the database and Base RPC; restarting the API fixes neither.
- The worker image has no healthcheck by design: it serves nothing, and the questions worth
  asking are answered from the database it shares — `worker_state`'s heartbeat, the API's
  `/ready` `execution_available`, and the aggregate functions in `infra/postgres/04-metrics.sql`.
- The worker starts in observation mode. Live execution needs `WORKER_EXECUTE=1`,
  `WORKER_PRIVATE_KEY`, the matching `SPENDER_ADDRESS` and an explicit `ELIGIBLE_COUNTRIES`;
  see `docs/runbooks/worker-local.md`.

## Deliberately not here

- **No API or worker service in `compose.yaml`.** The development loop is `bun run dev:api` with
  watch mode against this database; a compose service would rebuild an image on every save. The
  production images are built and run on their own, above.
- **No web image.** The Next.js build is a separate artifact with its own public environment
  variables, and putting it here would pull the 1.5 GB of browser dependencies that `--filter`
  exists to keep out.
- **No Prometheus, Grafana or exporter.** `infra/monitoring` owns that; the database side of it
  (`mandate_metrics` and the aggregate functions) is already installed by `apply-grants.sh`.
- **No migration container.** `bun run db:migrate` is an explicit command run with owner
  credentials that the application never holds; wrapping it in a service invites running it
  automatically at startup, which is exactly what this schema's ownership split prevents.
