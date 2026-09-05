ALTER TABLE "mandate_v2"."executions" ADD CONSTRAINT "execution_owner" UNIQUE("id","user_id");--> statement-breakpoint
CREATE TABLE "mandate_v2"."transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"leg" text NOT NULL,
	"signer" text NOT NULL,
	"nonce" integer NOT NULL,
	"raw_transaction" text NOT NULL,
	"hash" text NOT NULL,
	"status" text DEFAULT 'signed' NOT NULL,
	"evidence" jsonb,
	"created_at" timestamp (3) with time zone NOT NULL,
	"confirmed_at" timestamp (3) with time zone,
	CONSTRAINT "transactions_hash_unique" UNIQUE("hash"),
	CONSTRAINT "execution_leg" UNIQUE("execution_id","leg"),
	CONSTRAINT "signer_nonce" UNIQUE("signer","nonce"),
	CONSTRAINT "transaction_status_valid" CHECK ("mandate_v2"."transactions"."status" in ('signed','confirmed','reverted')),
	CONSTRAINT "transaction_nonce_valid" CHECK ("mandate_v2"."transactions"."nonce" >= 0),
	CONSTRAINT "transaction_leg_valid" CHECK ("mandate_v2"."transactions"."leg" in ('fund','approve','swap','reset','refund'))
);
--> statement-breakpoint
ALTER TABLE "mandate_v2"."transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "mandate_v2"."worker_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"generation" uuid NOT NULL,
	"heartbeat_at" timestamp (3) with time zone NOT NULL,
	"execution_available" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mandate_v2"."executions" DROP CONSTRAINT "execution_status_valid";--> statement-breakpoint
ALTER TABLE "mandate_v2"."evaluations" ADD COLUMN "notifications" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mandate_v2"."executions" ADD COLUMN "updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "mandate_v2"."executions" ADD COLUMN "intent" jsonb;--> statement-breakpoint
ALTER TABLE "mandate_v2"."executions" ADD COLUMN "stage" text DEFAULT 'fund' NOT NULL;--> statement-breakpoint
ALTER TABLE "mandate_v2"."instances" ADD COLUMN "eligible_country" text;--> statement-breakpoint
ALTER TABLE "mandate_v2"."instances" ADD COLUMN "eligibility_expires_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "mandate_v2"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_v2"."transactions" ADD CONSTRAINT "transactions_execution_id_user_id_executions_id_user_id_fk" FOREIGN KEY ("execution_id","user_id") REFERENCES "mandate_v2"."executions"("id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_v2"."executions" ADD CONSTRAINT "execution_status_valid" CHECK ("mandate_v2"."executions"."status" in ('signal','admitted','pending','confirmed','reverted','cancelled','refunded','recovery_required'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "mandate_v2"."transactions" AS PERMISSIVE FOR ALL TO public USING ("mandate_v2"."transactions"."user_id" = nullif(current_setting('mandate.user_id', true), '')::uuid) WITH CHECK ("mandate_v2"."transactions"."user_id" = nullif(current_setting('mandate.user_id', true), '')::uuid);