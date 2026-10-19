CREATE TABLE "correction_counts" (
	"quarter" text NOT NULL,
	"feature" text NOT NULL,
	"resolution" text NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "correction_counts_quarter_feature_resolution_pk" PRIMARY KEY("quarter","feature","resolution")
);
--> statement-breakpoint
CREATE TABLE "problem_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"from" text,
	"channel" text NOT NULL,
	"listed" boolean NOT NULL,
	"extension" text NOT NULL,
	"browser" text NOT NULL,
	"browser_major" integer NOT NULL,
	"platform" text,
	"adapter" text,
	"adapter_order" bigint,
	"topic" text,
	"choices" jsonb NOT NULL,
	"first_from_network" boolean NOT NULL,
	"details" jsonb NOT NULL,
	"unknown_codes" integer DEFAULT 0 NOT NULL,
	"message" text,
	"contact" text,
	"handled_at" timestamp with time zone,
	"handled_by" text,
	"resolution" text
);
--> statement-breakpoint
CREATE TABLE "report_floors" (
	"platform" text PRIMARY KEY NOT NULL,
	"adapter" text NOT NULL,
	"adapter_order" bigint NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	"set_by" text
);
--> statement-breakpoint
ALTER TABLE "problem_reports" ADD CONSTRAINT "problem_reports_handled_by_user_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_floors" ADD CONSTRAINT "report_floors_set_by_user_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "problem_reports_ref" ON "problem_reports" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "problem_reports_received_at" ON "problem_reports" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "problem_reports_group" ON "problem_reports" USING btree ("platform","adapter_order","kind","topic");--> statement-breakpoint
CREATE INDEX "problem_reports_open" ON "problem_reports" USING btree ("received_at") WHERE "problem_reports"."handled_at" is null;