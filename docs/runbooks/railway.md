# Deploying Mandate to Railway

Four resources in one project: **postgres**, **api**, **web**, **worker**. Declared in
[`.railway/railway.ts`](../../.railway/railway.ts) — that file is the source of truth, not the
dashboard.

`railway.json` and `railway.toml` are deprecated and stop being read on 2026-12-01. Do not add
them.

## Before the first deploy

**There is no git remote.** Railway has nothing to watch, so deploys come from `railway up` at the
repository root. Once the code is on GitHub, add a source to each service in the authoring file —
and note the branch here is `master`, not `main`:

```ts
source: github("<owner>/<repo>", { branch: "master" }),
```

Everything builds from the repository root, never from `apps/api` or `apps/web`. This is a Bun
workspace: `apps/api` imports eight local `@mandate/*` packages, and a build rooted at the app
directory cannot resolve them. The root scripts already produce a single bundle per target.

## The variables that must be set

Railway injects `PORT`, `DATABASE_URL` (from the Postgres reference) and
`RAILWAY_PRIVATE_DOMAIN`. Everything below is yours to supply.

### api — required

| Variable | Why |
|---|---|
| `PRIVY_APP_ID` | Login fails closed without it; `loadConfig` refuses to start. |
| `PRIVY_APP_SECRET` | Server-side token verification. Never expose to the browser. |
| `APP_ORIGIN` | The web service's public URL. Must be a bare origin — no path, no credentials — and HTTPS in production, both enforced at boot. |
| `BASE_RPC_URL` | A Base mainnet endpoint. See the note on rate limits below. |
| `ELIGIBLE_COUNTRIES` | Comma-separated ISO codes. `US` is rejected outright: these are non-US-only products. |

Optional: `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` enable plain-language strategy authoring and
must be set **together or not at all** — one without the other fails at boot rather than silently
disabling the feature. `SPENDER_ADDRESS` is advisory for the API and required by the worker.

`HOST` is pinned to `0.0.0.0` in the authoring file. The default is `127.0.0.1`, and on Railway a
loopback bind produces a service that looks healthy in its own logs and is unreachable through the
proxy.

### web — required

| Variable | Why |
|---|---|
| `NEXT_PUBLIC_PRIVY_APP_ID` | Baked into the browser bundle to start the login flow. An app identifier, not a secret. It must match the API's `PRIVY_APP_ID`. |

`MANDATE_API_URL` is set from the API's private domain, so browser traffic to `/api/mandate/*` is
rewritten to the API without leaving Railway's network and without the API needing a public domain.

### worker — required to execute

The worker starts with `WORKER_EXECUTE=0` and evaluates without signing anything. Turning it on
means it will sign and broadcast real transactions on Base, so set it to `1` only once
`WORKER_PRIVATE_KEY` holds a funded key and `SPENDER_ADDRESS` matches the address that key derives.
The two are cross-checked at startup: a mismatch refuses to run rather than spending from an
unexpected wallet.

## The database has two roles, deliberately

`DATABASE_URL` and `MIGRATION_DATABASE_URL` are not interchangeable.

Migrations run as the **owner**. The application connects as a role that is `NOSUPERUSER`,
`NOBYPASSRLS`, and **not the schema owner** — in Postgres a table's owner is exempt from row-level
security unless `FORCE ROW LEVEL SECURITY` is set, so an app connecting as owner silently loses the
isolation between one user's strategies and another's. `databaseReady()` checks this and refuses to
report ready for a role with `rolsuper` or `rolbypassrls`, which is why `/ready` returns
`database: false` on a misconfigured deploy instead of quietly serving traffic.

Railway's managed Postgres gives one superuser role. Create the constrained role before the first
real deploy — see [`infra/postgres/`](../../infra/postgres) — and point `DATABASE_URL` at it while
`MIGRATION_DATABASE_URL` keeps the owner.

## Rate limits are a real failure mode here

`/v1/market` prices seven assets against Chainlink and probes Aerodrome across six tick spacings.
On a public RPC that is enough calls to matter: with the request pacer at its original 1200 ms
spacing a single refresh took **22.85 s** against a 10 s deadline, and every asset after the first
reported `chain-unavailable` — indistinguishable from Base being down. It runs in ~1.5 s at the
current 120 ms spacing.

Set `RPC_SPACING_MS=0` **only** with a paid endpoint. On a shared public URL, leave the default.

## Deploying

```bash
railway config plan          # review the diff first — always
railway config apply         # only after reading the plan
railway up                   # deploy the current directory
```

`railway up` returns once the upload is queued, which is **not** a successful deploy. Confirm it:

```bash
railway deployment list --json
railway logs --service api --lines 200
```

## Verifying a deploy

```bash
curl https://<api-domain>/health   # {"status":"ok"} — liveness only, touches nothing
curl https://<api-domain>/ready    # database, chain and worker reachability
```

`/ready` is the one that matters. `database: false` almost always means the role check above;
`chain: false` means the RPC is unreachable or is not Base mainnet (it verifies chain id 8453).

A tradability check that returns nothing is not necessarily broken. These are total-return equity
feeds with no heartbeat while the underlying market is shut, so over a weekend every symbol is
37–43 h stale. That is why the reference has two bounds: 26 h for "is this a live price" and 96 h
for "can this still anchor a deviation check". If everything reads untradable on a Monday morning,
check the feeds' `updated_at` before suspecting the venue.
