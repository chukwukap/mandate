# Rewrite scope

The Rust code in the sibling `mandate/` project remains the reference implementation.
Do not overwrite its database or reuse persisted strategy identifiers without an
explicit compatibility decision and migration.

| Existing Rust area | TypeScript owner |
| --- | --- |
| api | apps/api and packages/auth |
| mandated | apps/api and apps/worker entrypoints |
| strategy | packages/strategy |
| llm | packages/strategy/src/compiler |
| core transport types | packages/contracts |
| store | packages/database |
| evm | packages/evm |
| engine and keys | packages/execution and apps/worker |
| web | apps/web |

## Current status

| Area | Status |
| --- | --- |
| Fastify API, Privy authentication and signed authoring | Implemented and locally verified. |
| Drizzle migrations and tenant isolation | Implemented; PGlite and native PostgreSQL checks pass. |
| Stable permission payloads and onchain activation checks | Implemented. |
| Market references and directional quotes | Implemented; availability depends on actual RPC and liquidity. |
| Worker evaluation, transaction journal and partial-trade recovery | Implemented with documented execution limits. |
| Manual sell signals | Implemented; no automatic sell authority. |
| Automatic sells | Not implemented. |
| Complete exchange calendar and 24/7 execution | Not implemented. |
| Web workspace, onboarding and feature organization | Implemented; unit and browser checks run locally. |
| Complete browser/wallet journey | Privy credentials and funded wallet validation still required. |
| Import of Rust sessions, IDs, signatures or execution state | Not implemented; formats are incompatible. |
| Full Rust/TypeScript runtime parity | Not established by the current tests. |

The TypeScript authoring path uses a new `mandate/2` artifact format. Create fresh
reviews and permissions for this application; copying old authorization records
would not establish valid authority.

The port preserves key safety requirements: permission preparation reuses the same
payload during signing, onchain approval is checked before spending, catalogue
membership does not imply executable liquidity, and recovery reads and may resend
persisted bytes. Temporary spender custody and server-enforced strategy limits are
explicit in the signed review.

See [worker architecture](../architecture/worker.md),
[operational limits](../runbooks/worker-local.md) and the
[verification record](../architecture/worker-verification.md).
