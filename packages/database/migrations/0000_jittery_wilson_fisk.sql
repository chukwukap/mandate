CREATE SCHEMA "mandate_v2";
--> statement-breakpoint
CREATE TABLE "mandate_v2"."drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"artifact_id" text NOT NULL,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"plan" jsonb NOT NULL,
	"envelope" jsonb NOT NULL,
	"reading" text NOT NULL,
	"render_text" text NOT NULL,
	"render_hash" text NOT NULL,
	"confirm_message" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "drafts_artifact_id_unique" UNIQUE("artifact_id"),
	CONSTRAINT "draft_owner" UNIQUE("id","user_id"),
	CONSTRAINT "draft_mode_valid" CHECK ("mandate_v2"."drafts"."mode" in ('manual','auto'))
);
--> statement-breakpoint
ALTER TABLE "mandate_v2"."drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mandate_v2"."evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"admitted" integer DEFAULT 0 NOT NULL,
	"refused" text,
	"inputs" jsonb NOT NULL,
	CONSTRAINT "admissions_nonnegative" CHECK ("mandate_v2"."evaluations"."admitted" >= 0)
);
--> statement-breakpoint
ALTER TABLE "mandate_v2"."evaluations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mandate_v2"."executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"status" text NOT NULL,
	"token_in" text NOT NULL,
	"token_out" text NOT NULL,
	"amount_in" text NOT NULL,
	"tx_hash" text,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "execution_status_valid" CHECK ("mandate_v2"."executions"."status" in ('admitted','pending','confirmed','reverted','cancelled','recovery_required')),
	CONSTRAINT "execution_amount_valid" CHECK ("mandate_v2"."executions"."amount_in" ~ '^[0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "mandate_v2"."executions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mandate_v2"."instances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mode" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"halt_reason" text,
	"signature" text NOT NULL,
	"runtime" jsonb NOT NULL,
	"tick_interval_ms" integer DEFAULT 12000 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"next_tick_at" timestamp with time zone NOT NULL,
	"last_tick_at" timestamp with time zone,
	CONSTRAINT "instances_draft_id_unique" UNIQUE("draft_id"),
	CONSTRAINT "instance_owner" UNIQUE("id","user_id"),
	CONSTRAINT "instance_mode_valid" CHECK ("mandate_v2"."instances"."mode" in ('manual','auto')),
	CONSTRAINT "instance_status_valid" CHECK ("mandate_v2"."instances"."status" in ('armed','paused','halted','ended')),
	CONSTRAINT "tick_interval_valid" CHECK ("mandate_v2"."instances"."tick_interval_ms" between 1000 and 3600000)
);
--> statement-breakpoint
ALTER TABLE "mandate_v2"."instances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mandate_v2"."permissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"instance_id" uuid NOT NULL,
	"token" text NOT NULL,
	"payload" jsonb NOT NULL,
	"hash" text NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"signature" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "permissions_hash_unique" UNIQUE("hash"),
	CONSTRAINT "permission_instance_token" UNIQUE("instance_id","token"),
	CONSTRAINT "permission_status_valid" CHECK ("mandate_v2"."permissions"."status" in ('prepared','signed','active','revoked','expired')),
	CONSTRAINT "permission_has_signature" CHECK ("mandate_v2"."permissions"."status" not in ('signed','active') or "mandate_v2"."permissions"."signature" is not null)
);
--> statement-breakpoint
ALTER TABLE "mandate_v2"."permissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mandate_v2"."users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"privy_did" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_privy_did_unique" UNIQUE("privy_did"),
	CONSTRAINT "privy_did_valid" CHECK ("mandate_v2"."users"."privy_did" ~ '^did:privy:[A-Za-z0-9]+$')
);
--> statement-breakpoint
ALTER TABLE "mandate_v2"."drafts" ADD CONSTRAINT "drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "mandate_v2"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_v2"."evaluations" ADD CONSTRAINT "evaluations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "mandate_v2"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_v2"."evaluations" ADD CONSTRAINT "evaluations_instance_id_user_id_instances_id_user_id_fk" FOREIGN KEY ("instance_id","user_id") REFERENCES "mandate_v2"."instances"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_v2"."executions" ADD CONSTRAINT "executions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "mandate_v2"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_v2"."executions" ADD CONSTRAINT "executions_instance_id_user_id_instances_id_user_id_fk" FOREIGN KEY ("instance_id","user_id") REFERENCES "mandate_v2"."instances"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_v2"."instances" ADD CONSTRAINT "instances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "mandate_v2"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_v2"."instances" ADD CONSTRAINT "instances_draft_id_user_id_drafts_id_user_id_fk" FOREIGN KEY ("draft_id","user_id") REFERENCES "mandate_v2"."drafts"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_v2"."permissions" ADD CONSTRAINT "permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "mandate_v2"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_v2"."permissions" ADD CONSTRAINT "permissions_instance_id_user_id_instances_id_user_id_fk" FOREIGN KEY ("instance_id","user_id") REFERENCES "mandate_v2"."instances"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluations_time" ON "mandate_v2"."evaluations" USING btree ("instance_id","at");--> statement-breakpoint
CREATE INDEX "executions_time" ON "mandate_v2"."executions" USING btree ("instance_id","created_at");--> statement-breakpoint
CREATE INDEX "instance_schedule" ON "mandate_v2"."instances" USING btree ("status","next_tick_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mandate_v2"."drafts" AS PERMISSIVE FOR ALL TO public USING ("mandate_v2"."drafts"."user_id" = nullif(current_setting('mandate.user_id', true), '')::uuid) WITH CHECK ("mandate_v2"."drafts"."user_id" = nullif(current_setting('mandate.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mandate_v2"."evaluations" AS PERMISSIVE FOR ALL TO public USING ("mandate_v2"."evaluations"."user_id" = nullif(current_setting('mandate.user_id', true), '')::uuid) WITH CHECK ("mandate_v2"."evaluations"."user_id" = nullif(current_setting('mandate.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mandate_v2"."executions" AS PERMISSIVE FOR ALL TO public USING ("mandate_v2"."executions"."user_id" = nullif(current_setting('mandate.user_id', true), '')::uuid) WITH CHECK ("mandate_v2"."executions"."user_id" = nullif(current_setting('mandate.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mandate_v2"."instances" AS PERMISSIVE FOR ALL TO public USING ("mandate_v2"."instances"."user_id" = nullif(current_setting('mandate.user_id', true), '')::uuid) WITH CHECK ("mandate_v2"."instances"."user_id" = nullif(current_setting('mandate.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mandate_v2"."permissions" AS PERMISSIVE FOR ALL TO public USING ("mandate_v2"."permissions"."user_id" = nullif(current_setting('mandate.user_id', true), '')::uuid) WITH CHECK ("mandate_v2"."permissions"."user_id" = nullif(current_setting('mandate.user_id', true), '')::uuid);