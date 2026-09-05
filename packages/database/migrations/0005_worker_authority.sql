ALTER TABLE mandate_v2.transactions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION mandate_v2.protect_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Transaction journal is append-only' USING ERRCODE = '23514'; END IF;
  IF (to_jsonb(NEW) - 'status' - 'confirmed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'confirmed_at')
    OR (OLD.status <> 'signed' AND NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'Signed transaction is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER transaction_immutable BEFORE UPDATE OR DELETE ON mandate_v2.transactions
FOR EACH ROW EXECUTE FUNCTION mandate_v2.protect_transaction();
--> statement-breakpoint
CREATE FUNCTION mandate_v2.protect_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'stage' - 'reason' - 'tx_hash' - 'updated_at')
    IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'stage' - 'reason' - 'tx_hash' - 'updated_at') THEN
    RAISE EXCEPTION 'Admitted intent is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER execution_immutable BEFORE UPDATE ON mandate_v2.executions
FOR EACH ROW EXECUTE FUNCTION mandate_v2.protect_execution();
