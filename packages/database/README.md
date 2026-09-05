# Database

Drizzle schema, explicit migrations, tenant-scoped repositories and worker leadership.
Application data lives in `mandate_v2`; migration bookkeeping lives in
`mandate_migrations`. All tenant tables force row-level security. Triggers protect
signed authority, admitted intents and transaction journals.

`Repository` supports API operations. `WorkerStore` supports scheduling and journal
access; `WorkerLease` holds the session advisory lock and checks generation fencing.
Tests exercise both PGlite and native PostgreSQL.

See the [database model](../../docs/architecture/database.md) and
[development workflow](../../docs/development.md).
