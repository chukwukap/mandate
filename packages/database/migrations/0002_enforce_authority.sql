ALTER TABLE mandate_v2.drafts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mandate_v2.instances FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mandate_v2.permissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mandate_v2.evaluations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mandate_v2.executions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION mandate_v2.protect_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'drafts' THEN
    IF (to_jsonb(NEW) - 'consumed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'consumed_at')
      OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at) THEN
      RAISE EXCEPTION 'Signed draft authority is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'permissions' THEN
    IF (to_jsonb(NEW) - ARRAY['status','signature','updated_at']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['status','signature','updated_at'])
       OR (OLD.signature IS NOT NULL AND NEW.signature IS DISTINCT FROM OLD.signature) THEN
      RAISE EXCEPTION 'Prepared permission authority is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'instances' THEN
    IF ROW(NEW.id, NEW.user_id, NEW.draft_id, NEW.signature, NEW.created_at) IS DISTINCT FROM
       ROW(OLD.id, OLD.user_id, OLD.draft_id, OLD.signature, OLD.created_at) THEN
      RAISE EXCEPTION 'Instance authority is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER immutable_draft BEFORE UPDATE ON mandate_v2.drafts FOR EACH ROW EXECUTE FUNCTION mandate_v2.protect_authority();
--> statement-breakpoint
CREATE TRIGGER immutable_permission BEFORE UPDATE ON mandate_v2.permissions FOR EACH ROW EXECUTE FUNCTION mandate_v2.protect_authority();
--> statement-breakpoint
CREATE TRIGGER immutable_instance BEFORE UPDATE ON mandate_v2.instances FOR EACH ROW EXECUTE FUNCTION mandate_v2.protect_authority();
