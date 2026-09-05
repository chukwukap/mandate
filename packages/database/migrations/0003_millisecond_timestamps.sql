ALTER TABLE "mandate_v2"."drafts" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."drafts" ALTER COLUMN "expires_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."drafts" ALTER COLUMN "consumed_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."evaluations" ALTER COLUMN "at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."executions" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."instances" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."instances" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."instances" ALTER COLUMN "next_tick_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."instances" ALTER COLUMN "last_tick_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."permissions" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."permissions" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."users" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "mandate_v2"."users" ALTER COLUMN "created_at" SET DEFAULT now();