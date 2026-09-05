-- Roles and database-level privileges. Runs BEFORE `bun run db:migrate`.
--
-- Nothing here touches `mandate_v2`: migration 0000 issues `CREATE SCHEMA "mandate_v2"`, which
-- is an error if the schema already exists, so this file must not create it. It only arranges
-- for `mandate_owner` to be allowed to. Schema-level grants therefore live in 03-grants.sql,
-- which runs afterwards.
--
-- Run as a superuser (the container entrypoint, or your DBA):
--   psql -v ON_ERROR_STOP=1 -f infra/postgres/01-roles.sql -d mandate
--
-- Idempotent: safe to re-run against a database that already has these roles.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
--
-- No role here gets a password. A role with LOGIN and no password cannot authenticate under
-- scram-sha-256 or md5, so the failure mode of forgetting step two is "nobody can connect",
-- not "everybody can". Passwords are set out of band: 02-dev-passwords.sh for the local
-- container, your credential process everywhere else.
--
-- Every application role is explicitly NOSUPERUSER NOBYPASSRLS. Those are already the
-- defaults, but `databaseReady()` in packages/database/src/client.ts refuses to report ready
-- when `rolsuper OR rolbypassrls` is true, and stating it here means a later `ALTER ROLE`
-- that quietly grants one is visible as a diff against this file.

DO $$
BEGIN
  -- Owns both schemas and every object the migrations create. Used by exactly one command,
  -- `bun run db:migrate`, and by MIGRATION_DATABASE_URL only. The application never connects
  -- as this role: an owner can DROP the tables it queries, and the RLS policies are FORCE'd
  -- precisely so that owning a table is not a way around them.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mandate_owner') THEN
    CREATE ROLE mandate_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
      NOREPLICATION;
  END IF;

  -- The API. `.env.example` names this role `mandate`, and the name is load-bearing there,
  -- so it is kept even though `mandate_api` would read better beside `mandate_worker`.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mandate') THEN
    CREATE ROLE mandate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;

  -- The worker, named to match `.env.worker.example`. Its privileges genuinely differ from
  -- the API's: it is the only process that may write the signed-transaction journal, and the
  -- API is the only one that may create users, drafts and permissions. See 03-grants.sql.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mandate_worker') THEN
    CREATE ROLE mandate_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
      NOREPLICATION;
  END IF;

  -- The metrics scraper (infra/monitoring). It is granted EXECUTE on a handful of aggregate
  -- functions and SELECT on nothing at all, so a leaked scrape credential yields counts and
  -- ages and never a row of user data.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mandate_metrics') THEN
    CREATE ROLE mandate_metrics LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS
      NOREPLICATION;
  END IF;

  -- The one role in this system with BYPASSRLS, and it is NOLOGIN so nothing can ever
  -- authenticate as it. It exists only to own the SECURITY DEFINER functions in
  -- 04-metrics.sql. Aggregating across tenants requires seeing across tenants, and every
  -- other way of arranging that ends with a login role that can read every user's positions:
  --   * granting BYPASSRLS to mandate_metrics hands the whole database to a scrape credential;
  --   * a plain view does not help, because the tenant tables are FORCE ROW LEVEL SECURITY,
  --     so even the table owner is filtered by the policy;
  --   * setting `mandate.user_id` per user in the exporter turns one scrape into N queries
  --     and puts user ids in metric labels.
  -- A definer function returning only counts and ages is the narrowest thing that works.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mandate_metrics_reader') THEN
    CREATE ROLE mandate_metrics_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS
      NOREPLICATION;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Database privileges
-- ---------------------------------------------------------------------------
--
-- PUBLIC can CONNECT to every database by default, which means every role in the cluster --
-- including roles belonging to some unrelated service sharing the instance -- can open a
-- session here. CONNECT is re-granted only to the four roles that need it.
--
-- CREATE on the database is granted to mandate_owner alone, and that is what lets migration
-- 0000 create `mandate_v2` and the migrator create `mandate_migrations`. Revoking it from
-- PUBLIC also removes the default ability of any role to create a schema of its own here.

DO $$
DECLARE
  db text := quote_ident(current_database());
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %s FROM PUBLIC', db);
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %s TO mandate_owner', db);
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %s TO mandate, mandate_worker, mandate_metrics', db);
END
$$;

-- The `public` schema is unused by this application; nothing should be creatable there.
-- PostgreSQL 15+ already revokes CREATE from PUBLIC, but this database may have been
-- restored from an older dump, and a writable `public` is where a compromised role parks a
-- helper function.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO mandate_owner, mandate, mandate_worker, mandate_metrics;
