-- Least-privilege table grants. Runs AFTER `bun run db:migrate`.
--
--   psql -v ON_ERROR_STOP=1 -f infra/postgres/03-grants.sql -d mandate
--
-- Idempotent, and safe to re-run after every migration. Re-running it is in fact required:
-- a new table arrives with no grants, and this file raises rather than letting the API
-- discover that with a 500.
--
-- Two things this deliberately does NOT do.
--
-- ALTER DEFAULT PRIVILEGES would grant future tables automatically and is the usual advice.
-- It is wrong here. Whether a new table is readable by the API, writable by the worker, or
-- neither, is a decision about who may see user financial state, and a default privilege
-- makes that decision silently in favour of "everyone who already had access". The drift
-- check at the bottom turns the same operational problem -- a forgotten grant -- into a loud
-- failure during deployment instead.
--
-- No DELETE, anywhere, for any role. The repositories issue no DELETE (verified: the only
-- `.delete(` calls in the codebase are on in-memory Maps), the transaction journal has a
-- trigger that raises on DELETE, and the whole point of `executions`, `evaluations` and
-- `transactions` is that they are the record of what was done with someone's money. The
-- runbook's `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` is wider than the
-- application has ever needed.

-- ---------------------------------------------------------------------------
-- Schema access
-- ---------------------------------------------------------------------------
--
-- USAGE only. CREATE stays with mandate_owner, so a compromised application credential
-- cannot add a table, a view over someone else's rows, or a trigger function to the schema
-- the application itself queries.
GRANT USAGE ON SCHEMA mandate_v2
  TO mandate, mandate_worker, mandate_metrics, mandate_metrics_reader;

-- Migration bookkeeping is the migrator's business. The application roles must not be able
-- to read, and certainly not to rewrite, the ledger that decides which migrations are
-- considered applied.
-- Conditional: the migrator creates this schema, and 03 must also be runnable against a
-- database whose schema was installed by some other means.
DO $$
BEGIN
  IF to_regnamespace('mandate_migrations') IS NOT NULL THEN
    REVOKE ALL ON SCHEMA mandate_migrations
      FROM PUBLIC, mandate, mandate_worker, mandate_metrics;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Reset
-- ---------------------------------------------------------------------------
--
-- Revoke first so this file is authoritative rather than additive: a grant handed out by
-- hand during an incident, or by an older and wider version of this script, disappears on
-- the next deploy instead of surviving forever.
REVOKE ALL ON ALL TABLES IN SCHEMA mandate_v2
  FROM PUBLIC, mandate, mandate_worker, mandate_metrics, mandate_metrics_reader;

-- ---------------------------------------------------------------------------
-- API role (`mandate`, the DATABASE_URL in .env.example)
-- ---------------------------------------------------------------------------
--
-- The API authors: it creates users, drafts and instances, and updates their
-- lifecycle columns. It only ever reads the evaluation and execution history -- those rows
-- are written by the worker inside the same transaction that advances the budget counters,
-- and an API process that could insert an execution could manufacture an order that no
-- strategy ever admitted.
--
-- `transactions` is absent on purpose. It holds signed transaction bytes. The API has no
-- signer, never broadcasts, and exposes receipts from the chain rather than from the
-- journal, so it has no reason to be able to read raw signed payloads at all.
GRANT SELECT, INSERT         ON mandate_v2.users        TO mandate;
GRANT SELECT, INSERT, UPDATE ON mandate_v2.drafts       TO mandate;
GRANT SELECT, INSERT, UPDATE ON mandate_v2.instances    TO mandate;
GRANT SELECT                 ON mandate_v2.evaluations  TO mandate;
GRANT SELECT                 ON mandate_v2.executions   TO mandate;
-- Read-only: `execution_available` on /ready is a report about the worker, and the API must
-- never be able to claim leadership or forge a heartbeat.
GRANT SELECT                 ON mandate_v2.worker_state TO mandate;

-- ---------------------------------------------------------------------------
-- Worker role (`mandate_worker`)
-- ---------------------------------------------------------------------------
--
-- The worker executes: it evaluates instances, admits intents, journals signed transactions
-- and reconciles receipts. It cannot create a user, a draft or a permission -- those come
-- from a signature the user produced in the browser, and nothing in the worker's path should
-- be able to invent one.
--
-- INSERT without UPDATE on `evaluations` matches the append-only history the API pages over.
GRANT SELECT                 ON mandate_v2.users        TO mandate_worker;
GRANT SELECT                 ON mandate_v2.drafts       TO mandate_worker;
GRANT SELECT, UPDATE         ON mandate_v2.instances    TO mandate_worker;
GRANT SELECT, INSERT         ON mandate_v2.evaluations  TO mandate_worker;
GRANT SELECT, INSERT, UPDATE ON mandate_v2.executions   TO mandate_worker;
GRANT SELECT, INSERT, UPDATE ON mandate_v2.transactions TO mandate_worker;
GRANT SELECT, INSERT, UPDATE ON mandate_v2.worker_state TO mandate_worker;

-- ---------------------------------------------------------------------------
-- Metrics definer role
-- ---------------------------------------------------------------------------
--
-- NOLOGIN and BYPASSRLS (see 01-roles.sql). These grants are what its SECURITY DEFINER
-- functions in 04-metrics.sql run with. `mandate_metrics` itself gets nothing here -- it
-- receives EXECUTE on those functions and no table privilege whatsoever.
GRANT SELECT ON ALL TABLES IN SCHEMA mandate_v2 TO mandate_metrics_reader;

-- ---------------------------------------------------------------------------
-- Invariants
-- ---------------------------------------------------------------------------

-- A table this file has never heard of has no grants, and the first request that needs it
-- fails with "permission denied" in production. Fail here instead, during the deploy step
-- that was supposed to notice.
DO $$
DECLARE
  known text[] := ARRAY[
    'users', 'drafts', 'instances',
    'evaluations', 'executions', 'transactions', 'worker_state'
  ];
  unexpected text;
  missing text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unexpected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'mandate_v2' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND NOT (c.relname = ANY (known));
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION
      'mandate_v2 contains relations this grant script does not cover: %. Decide which roles may read or write them and add explicit grants above.',
      unexpected;
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO missing
  FROM unnest(known) AS name
  WHERE to_regclass('mandate_v2.' || quote_ident(name)) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'mandate_v2 is missing expected tables: %. Run `bun run db:migrate` before this script.',
      missing;
  END IF;
END
$$;

-- No sequence exists today: every identifier is a client-generated uuid and worker_state.id
-- is the literal 1. If a migration ever adds `serial`, INSERT alone is not enough -- the
-- insert fails with "permission denied for sequence" -- so catch it here rather than in the
-- first order of the day.
DO $$
DECLARE
  found text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO found
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'mandate_v2' AND c.relkind = 'S';
  IF found IS NOT NULL THEN
    RAISE EXCEPTION
      'mandate_v2 gained sequences (%). Add USAGE grants for the roles that insert into their tables.',
      found;
  END IF;
END
$$;

-- The same condition `databaseReady()` checks at runtime, asserted at deploy time. A role
-- with BYPASSRLS reads every tenant's rows regardless of `mandate.user_id`, and the symptom
-- -- the API refusing to become ready with no further explanation -- is a poor way to find
-- out that someone granted it during an incident and never took it back.
DO $$
DECLARE
  offenders text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO offenders
  FROM pg_roles
  WHERE rolname IN ('mandate', 'mandate_worker', 'mandate_metrics')
    AND (rolsuper OR rolbypassrls);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION
      'Application roles must not be SUPERUSER or BYPASSRLS: %. Row-level security is the tenant boundary.',
      offenders;
  END IF;
END
$$;

-- The application must not own what it queries: an owner can DROP a table, disable a
-- trigger, or ALTER a policy. Ownership belongs to mandate_owner, which only the migration
-- command connects as.
DO $$
DECLARE
  owner text;
BEGIN
  SELECT pg_get_userbyid(nspowner) INTO owner FROM pg_namespace WHERE nspname = 'mandate_v2';
  IF owner IN ('mandate', 'mandate_worker', 'mandate_metrics') THEN
    RAISE EXCEPTION
      'mandate_v2 is owned by the application role %. Re-run migrations as mandate_owner.',
      owner;
  END IF;
END
$$;
