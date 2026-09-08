# Mandate documentation

Mandate's TypeScript rewrite runs a Fastify API and a background worker on Node.js.
Bun manages packages, builds and tests. PostgreSQL stores signed strategy artifacts,
runtime state, spending permissions and transaction journals. Privy authenticates
API users. The Next.js web workspace supports stock browsing and strategy authoring.

## Start here

| Task | Guide |
| --- | --- |
| Run or preview the web workspace | [Web setup](../apps/web/README.md) |
| Run the API and create the database schema | [API setup](runbooks/api-local.md) |
| Run the worker and inspect recovery | [Worker setup](runbooks/worker-local.md) |
| Configure either process | [Configuration reference](reference/configuration.md) |
| Integrate a client | [API contract](api/README.md) |
| Understand evaluation and transaction states | [Worker architecture](architecture/worker.md) |
| Understand ownership and persisted records | [Database model](architecture/database.md) |
| Change and verify the code | [Development workflow](development.md) |

## Architecture and trust

- [Web feature structure](architecture/web.md)
- [Onboarding design](product/onboarding.md)
- [What users can actually strategise](product/strategies.md) — the engine's real limits, measured, with 17 validated plans
- [Remaining directory placeholders](migration/structure-audit.md)
- [Package boundaries](architecture/README.md)
- [Privy authentication decision](architecture/decisions/0001-privy-auth.md)
- [API security boundaries](security/api.md)
- [Rewrite compatibility and remaining work](migration/README.md)

## Implemented behavior

The API supports authenticated authoring, signed reviews, lifecycle controls,
permission preparation and read-only quotes. The worker evaluates manual strategies
into signals and can execute authorized USDC-funded stock buys. It persists signed
transactions before sending them, resumes their receipt checks after a restart,
and attempts an exact-input refund when a funded trade cannot finish.

Live execution defaults to off. Automatic sells, a complete
exchange-session calendar, automatic fee replacement and a general operator recovery
UI are not implemented. Unresolved transaction evidence requires operator review.
See the worker runbook for the precise execution window and accounting limits.

## Verification records

[API verification](api/verification.md) and [worker verification](architecture/worker-verification.md)
record completed checks and their limits. Tests exercise local databases, mocked
RPC responses and fixture signatures. They do not establish funded mainnet execution
or a complete browser-to-wallet production journey.
