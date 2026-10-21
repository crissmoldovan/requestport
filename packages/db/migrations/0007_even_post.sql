ALTER TABLE "questions" ADD COLUMN "asked_by_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "asked_by_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_asked_by_type_check" CHECK ("questions"."asked_by_type" in ('user', 'agent', 'service'));--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_version_check" CHECK ("questions"."version" > 0);