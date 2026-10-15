CREATE TABLE "ai_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"base_url" text,
	"effort" text DEFAULT 'low' NOT NULL,
	"data_policy" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"eval_passed_at" timestamp with time zone,
	"eval_agreement" double precision,
	"eval_prompt_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_routes_one_enabled_per_task" ON "ai_routes" USING btree ("task") WHERE "ai_routes"."enabled";