-- Aggregate-only metrics surface for infra/monitoring. Runs AFTER 03-grants.sql.
--
--   psql -v ON_ERROR_STOP=1 -f infra/postgres/04-metrics.sql -d mandate
--
-- Idempotent (CREATE OR REPLACE throughout).
--
-- Every function here is SECURITY DEFINER, owned by `mandate_metrics_reader` (NOLOGIN,
-- BYPASSRLS), and returns nothing but counts, ages and sums. The scrape role
-- `mandate_metrics` holds EXECUTE on these and SELECT on no table in this database, so the
-- worst a stolen scrape credential yields is "there are four pending swap transactions and
-- the oldest is 90 seconds old" -- never whose, never for how much, never an address.
--
-- Why definer functions at all: the tenant tables are FORCE ROW LEVEL SECURITY, so a query
-- without `mandate.user_id` set returns zero rows for every role including the table owner.
-- A monitoring query must see across tenants by definition. The alternatives are worse --
-- see the comment on mandate_metrics_reader in 01-roles.sql.
--
-- `SET search_path = pg_catalog, pg_temp` on every definer function is not decoration. A
-- SECURITY DEFINER function that inherits the caller's search_path can be made to call an
-- attacker-supplied `count()` planted in a schema the caller controls, and it would run with
-- BYPASSRLS. Everything below is schema-qualified because of it.
--
-- Label discipline: no function returns a user id, instance id, execution id, address or
-- amount. Those are unbounded-cardinality labels that would melt a Prometheus instance, and
-- they are also tenant data leaving the database for a store with no tenant boundary at all.
-- Bounded enums only -- status, stage, leg, mode, outcome -- all of which are constrained by
-- CHECK constraints in the schema.

-- ---------------------------------------------------------------------------
-- Strategy population and schedule health
-- ---------------------------------------------------------------------------

-- Census of strategies. `status` is armed|paused|halted|ended, `mode` is manual|auto.
CREATE OR REPLACE FUNCTION mandate_v2.metrics_instances()
RETURNS TABLE (status text, mode text, instances double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT i.status, i.mode, count(*)::double precision
    FROM mandate_v2.instances i
    GROUP BY i.status, i.mode;
END
$$;

-- How far behind its own schedule the worker is.
--
-- `next_tick_at` is the contract between the scheduler and the strategy: an armed instance
-- whose due time is in the past is one whose rules are not being evaluated against current
-- prices. Lag is measured only over armed instances, because a paused or ended instance
-- keeps whatever due time it had when it stopped and would otherwise dominate the maximum
-- forever.
--
-- The maximum, not the mean: one instance starved behind a stuck order is a real incident
-- that an average over a thousand healthy instances hides completely.
CREATE OR REPLACE FUNCTION mandate_v2.metrics_schedule()
RETURNS TABLE (armed double precision, overdue double precision, max_lag_seconds double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT
      count(*)::double precision,
      count(*) FILTER (WHERE i.next_tick_at < now())::double precision,
      -- 0, not NULL, when nothing is overdue: this is the healthy value, and a gauge that
      -- vanishes when healthy makes every comparison in an alert rule evaluate to "no data".
      coalesce(
        max(extract(epoch FROM now() - i.next_tick_at))
          FILTER (WHERE i.next_tick_at < now()),
        0)::double precision
    FROM mandate_v2.instances i
    WHERE i.status = 'armed';
END
$$;

-- ---------------------------------------------------------------------------
-- Evaluation outcomes
-- ---------------------------------------------------------------------------

-- Evaluation outcomes over a fixed 15-minute window.
--
-- A window rather than a lifetime counter because these rows are the only durable trace of
-- why the system is or is not trading, and the question an operator asks is always "right
-- now", never "since the beginning of time". 15 minutes is long enough that a 12s default
-- tick interval puts dozens of rows in it for a single instance, so one unlucky tick cannot
-- move the number much, and short enough that a resolved incident clears within one coffee.
--
-- The interesting outcomes are documented in apps/worker/src/scheduler/cadence.ts:
--   evaluated                              the rules actually ran
--   observation-or-authority-unavailable   oracle, DEX or permission read failed
--   observation-expired                    the reading went stale before the write committed
--   execution-disabled                     WORKER_EXECUTE=0
--   expired | halted                       terminal, admission moved the instance out of armed
--   eligibility-renewal-required           the 24h country attestation lapsed
--   deferred | late | degraded             written by the scheduler about itself
-- An outcome this file has never seen still appears as its own label; the alert rules count
-- what is NOT `evaluated` rather than enumerating failures, so a new failure mode added by a
-- future build is visible on the day it ships instead of on the day someone updates a list.
CREATE OR REPLACE FUNCTION mandate_v2.metrics_evaluations()
RETURNS TABLE (outcome text, evaluations double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT e.outcome, count(*)::double precision
    FROM mandate_v2.evaluations e
    WHERE e.at > now() - interval '15 minutes'
    GROUP BY e.outcome;
END
$$;

-- ---------------------------------------------------------------------------
-- Order pipeline
-- ---------------------------------------------------------------------------

-- Lifetime census of orders by status and stage.
--
-- `recovery_required` is the one that matters most: it halts its strategy and blocks new
-- automatic admission globally (see docs/runbooks/worker-local.md), so a single row here is
-- a system-wide stop, not a per-user inconvenience.
CREATE OR REPLACE FUNCTION mandate_v2.metrics_executions()
RETURNS TABLE (status text, stage text, executions double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT x.status, x.stage, count(*)::double precision
    FROM mandate_v2.executions x
    GROUP BY x.status, x.stage;
END
$$;

-- Orders that changed status in the last 15 minutes, matching metrics_evaluations()'s window.
--
-- This is the submission-failure signal. The census above cannot provide it: a database that
-- has accumulated forty reverted orders over six months and a database that reverted forty
-- orders in the last five minutes are the same number, and only one of them is an incident.
CREATE OR REPLACE FUNCTION mandate_v2.metrics_execution_activity()
RETURNS TABLE (status text, executions double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT x.status, count(*)::double precision
    FROM mandate_v2.executions x
    WHERE x.updated_at > now() - interval '15 minutes'
    GROUP BY x.status;
END
$$;

-- Orders sitting in a non-terminal state, and how long the oldest has been there.
--
-- `admitted` means the intent is reserved against the signed envelope but nothing has been
-- signed; `pending` means at least one leg is in flight. Both are supposed to be transient:
-- funding, approval and swap each wait WORKER_CONFIRMATIONS blocks on a ~2s chain, so the
-- whole sequence is a couple of minutes. An order that has been `admitted` for an hour has
-- consumed the user's period budget for an order that will never happen.
CREATE OR REPLACE FUNCTION mandate_v2.metrics_execution_open()
RETURNS TABLE (
  status text, stage text, executions double precision, oldest_age_seconds double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT
      x.status,
      x.stage,
      count(*)::double precision,
      max(extract(epoch FROM now() - x.updated_at))::double precision
    FROM mandate_v2.executions x
    WHERE x.status IN ('admitted', 'pending')
    GROUP BY x.status, x.stage;
END
$$;

-- ---------------------------------------------------------------------------
-- Signed transaction journal
-- ---------------------------------------------------------------------------

-- Census of journalled transactions by leg and status.
CREATE OR REPLACE FUNCTION mandate_v2.metrics_transactions()
RETURNS TABLE (leg text, status text, transactions double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT t.leg, t.status, count(*)::double precision
    FROM mandate_v2.transactions t
    GROUP BY t.leg, t.status;
END
$$;

-- Broadcast transactions with no receipt yet, per leg, with the age of the oldest.
--
-- `signed` is the journal's word for "these exact bytes were written before broadcast and no
-- confirmed or reverted receipt has been recorded". It is the only state in this system that
-- can be simultaneously true and unresolvable: the transaction may be in the mempool, may
-- have been dropped, may already be mined and awaiting confirmations. That ambiguity is why
-- the runbook forbids reusing a nonce, and it is why an age here is worth paging on.
--
-- Rows are emitted per leg because the legs fail differently: a stuck `fund` leg has pulled
-- nothing yet, while a stuck `swap` leg has the user's USDC sitting in the spender wallet.
CREATE OR REPLACE FUNCTION mandate_v2.metrics_transaction_pending()
RETURNS TABLE (leg text, pending double precision, oldest_age_seconds double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT
      t.leg,
      count(*)::double precision,
      max(extract(epoch FROM now() - t.created_at))::double precision
    FROM mandate_v2.transactions t
    WHERE t.status = 'signed'
    GROUP BY t.leg;
END
$$;

-- ---------------------------------------------------------------------------
-- Spend permissions
-- ---------------------------------------------------------------------------

-- Census of spend permissions by stored status.
CREATE OR REPLACE FUNCTION mandate_v2.metrics_permissions()
RETURNS TABLE (status text, permissions double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT p.status, count(*)::double precision
    FROM mandate_v2.permissions p
    GROUP BY p.status;
END
$$;

-- Onchain spend authority behind strategies that are still armed.
--
-- Scoped to armed instances on purpose. A permission expiring on a paused strategy is not an
-- event; a permission expiring under a strategy that is still evaluating rules every twelve
-- seconds means every order it admits from that moment is refused at the funding gate, and
-- the user sees a strategy that looks alive and does nothing.
--
-- `payload->>'end'` is uint48 unix seconds, written once at prepare time and protected by an
-- immutability trigger, so it is the authoritative expiry -- `status` is only this server's
-- observation of the chain and can lag it.
--
-- `stranded` is the state that is already broken rather than approaching: armed, but with no
-- permission row in `active` at all (revoked onchain, expired, or never signed).
CREATE OR REPLACE FUNCTION mandate_v2.metrics_permission_authority()
RETURNS TABLE (
  armed double precision,
  stranded double precision,
  expiring_1h double precision,
  expiring_24h double precision,
  expiring_72h double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
    WITH armed_auto AS (
      SELECT i.id
      FROM mandate_v2.instances i
      WHERE i.status = 'armed' AND i.mode = 'auto'
    ),
    authority AS (
      SELECT
        a.id,
        max((p.payload ->> 'end')::bigint) FILTER (WHERE p.status = 'active') AS ends_at
      FROM armed_auto a
      LEFT JOIN mandate_v2.permissions p ON p.instance_id = a.id
      GROUP BY a.id
    )
    SELECT
      count(*)::double precision,
      count(*) FILTER (WHERE ends_at IS NULL)::double precision,
      count(*) FILTER (
        WHERE ends_at IS NOT NULL
          AND ends_at - extract(epoch FROM now()) BETWEEN 0 AND 3600)::double precision,
      count(*) FILTER (
        WHERE ends_at IS NOT NULL
          AND ends_at - extract(epoch FROM now()) BETWEEN 0 AND 86400)::double precision,
      count(*) FILTER (
        WHERE ends_at IS NOT NULL
          AND ends_at - extract(epoch FROM now()) BETWEEN 0 AND 259200)::double precision
    FROM authority;
END
$$;

-- ---------------------------------------------------------------------------
-- Worker leadership
-- ---------------------------------------------------------------------------

-- Whether a worker is alive, how stale its heartbeat is, and whether it can execute.
--
-- Exactly one row, always, even before any worker has ever started: a `LEFT JOIN` against a
-- single-row scaffold. A heartbeat metric that disappears when the worker has never run is
-- indistinguishable in PromQL from a metrics endpoint that is down, and those need different
-- responses.
--
-- A never-seen heartbeat reports 86400 seconds rather than NULL. Absent is not fresh, and
-- clamping to a day keeps the series plottable while still exceeding every threshold that
-- matters. `leader` distinguishes the two cases for anyone who needs to.
CREATE OR REPLACE FUNCTION mandate_v2.metrics_worker()
RETURNS TABLE (
  leader double precision,
  heartbeat_age_seconds double precision,
  execution_available double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT
      (w.id IS NOT NULL)::int::double precision,
      coalesce(extract(epoch FROM now() - w.heartbeat_at), 86400)::double precision,
      coalesce(w.execution_available, 0)::double precision
    FROM (SELECT 1) AS scaffold
    LEFT JOIN mandate_v2.worker_state w ON w.id = 1;
END
$$;

-- ---------------------------------------------------------------------------
-- Ownership and access
-- ---------------------------------------------------------------------------
--
-- Ownership transfer is what makes these run with BYPASSRLS. Doing it in one DO block over
-- pg_proc rather than eight ALTER statements means a function added above cannot be
-- forgotten here -- and a forgotten one would silently return zeros for every tenant table,
-- which reads exactly like a healthy, idle system.
DO $$
DECLARE
  fn text;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'mandate_v2' AND p.proname LIKE 'metrics\_%'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO mandate_metrics_reader', fn);
    -- EXECUTE is granted to PUBLIC by default on a new function. On a SECURITY DEFINER
    -- function that bypasses row-level security, that default would hand every tenant's
    -- aggregate totals to the API and worker roles as well.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO mandate_metrics', fn);
  END LOOP;
END
$$;

-- The scrape role must be able to reach the schema to call the functions, and must not be
-- able to read anything in it directly. 03-grants.sql revoked its table privileges; this
-- re-asserts the negative so the two files cannot drift into a state where only one of them
-- is applied.
GRANT USAGE ON SCHEMA mandate_v2 TO mandate_metrics;
REVOKE ALL ON ALL TABLES IN SCHEMA mandate_v2 FROM mandate_metrics;

DO $$
DECLARE
  leaked text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO leaked
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'mandate_v2' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND pg_catalog.has_table_privilege('mandate_metrics', c.oid, 'SELECT');
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION
      'mandate_metrics can read tables directly (%). The scrape role must reach data only through the aggregate functions.',
      leaked;
  END IF;
END
$$;
