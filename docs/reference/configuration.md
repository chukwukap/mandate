# Configuration reference

Run all commands from `mandate-node/`. API scripts load `.env`; worker scripts load
`.env.worker`. Existing process environment variables take precedence over these
files. Copy the matching example file and configure each process separately.
Empty strings are treated as unset by the configuration loaders.

The source of truth is [API configuration](../../packages/config/src/index.ts) and
[worker configuration](../../packages/config/src/worker.ts).

## Shared settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. |
| `DATABASE_URL` | Required | PostgreSQL connection for a restricted application role. |
| `APP_ORIGIN` | `http://localhost:3000` | Exact HTTP origin, without a path; HTTPS required in production. Must match the origin in signed reviews. |
| `BASE_RPC_URL` | `https://mainnet.base.org` | HTTP(S) Base RPC. Capacity and latency affect quotes and execution. |
| `SPENDER_ADDRESS` | Unset | Public spender address. Required for API permission preparation and live worker execution. |
| `ELIGIBLE_COUNTRIES` | Empty | Comma-separated uppercase country codes; `US` and `XX` are rejected. An empty list admits no eligible countries. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |

The worker example selects `https://base-rpc.publicnode.com`; the loader's fallback
remains `https://mainnet.base.org`. Neither public endpoint guarantees sufficient
capacity for production execution.

## API settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind address. |
| `PORT` | `8080` | HTTP port; `0` allows an ephemeral port for tests. |
| `PRIVY_APP_ID` | Required | Privy app identifier used to verify the access-token audience. |
| `PRIVY_APP_SECRET` | Required | Server-only Privy credential for account lookup. |
| `API_DOCS` | `0` | Set `1` to expose `/openapi.json`. |
| `ANTHROPIC_API_KEY` | Unset | Optional text-authoring credential; set with `ANTHROPIC_MODEL`. |
| `ANTHROPIC_MODEL` | Unset | Explicit authoring model identifier; set with the API key. |
| `TRUSTED_PROXY_IPS` | Empty | Exact ingress IP addresses trusted to supply `cf-ipcountry`. |
| `DEV_COUNTRY` | Unset | Local development jurisdiction override; ignored in production. |

`NEXT_PUBLIC_PRIVY_APP_ID` in the example file reserves the future client's public
app ID. The API does not read it. It must match `PRIVY_APP_ID` when the client is
implemented; no secret belongs in a public-prefixed variable.

## Worker settings

| Variable | Default | Validation and behavior |
| --- | --- | --- |
| `WORKER_EXECUTE` | `0` | `1` enables signing and reconciliation that may broadcast transactions. |
| `WORKER_PRIVATE_KEY` | Unset | `0x` plus 64 hex characters. Live execution requires a key whose address matches `SPENDER_ADDRESS`. |
| `WORKER_POLL_MS` | `2000` | Integer, 250–60,000 milliseconds between cycles. Work duration adds to this interval. |
| `WORKER_MAX_BATCH` | `10` | Integer, 1–100; bounds owner pages and due-instance work per cycle. |
| `WORKER_CONFIRMATIONS` | `3` | Integer, 2–64 confirmations required for receipt progression. |
| `WORKER_RECEIPT_TIMEOUT_MS` | `1800000` | Integer, 60,000–86,400,000. Unresolved pending evidence after this age requires recovery review. |

The worker does not require Privy or Anthropic credentials. With execution disabled,
it does not load a signing account. Persisted automatic work still blocks further
admission until an execution-enabled worker reconciles it.

These values are currently fixed in code: 30-second heartbeat freshness, 10-second
heartbeat interval, 24-hour eligibility attestations, 60-second funding-intent
expiry, five-minute execution-reference freshness and the 09:35–15:55 weekday
New York execution window. They are not environment switches.

## Migration and test settings

`MIGRATION_DATABASE_URL` is required by `bun run db:migrate`; the command does not
fall back to `DATABASE_URL`. Use the migration owner, then grant application roles
access to the new tables. Startup never applies migrations.

`TEST_DATABASE_URL` selects native PostgreSQL for integration tests. Without it,
ordinary database tests use PGlite. The isolated test script manages this setting
itself. `PG_BIN` selects the PostgreSQL executable directory; see the
[development workflow](../development.md).

Keep `.env`, `.env.worker`, private keys and database credentials out of source
control. The API gets only the spender's public address. A signer must be dedicated
to one worker database so its nonce and funded balances remain attributable.
