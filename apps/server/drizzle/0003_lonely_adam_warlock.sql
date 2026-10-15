CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"device_id" uuid,
	"route_id" uuid,
	"task" text NOT NULL,
	"model" text NOT NULL,
	"outcome" text NOT NULL,
	"posts_requested" integer NOT NULL,
	"posts_ok" integer NOT NULL,
	"calls" integer NOT NULL,
	"failed_calls" integer NOT NULL,
	"uncached_input" integer NOT NULL,
	"cache_read" integer NOT NULL,
	"cache_write" integer NOT NULL,
	"output" integer NOT NULL,
	"web_searches" integer NOT NULL,
	"estimated" boolean NOT NULL,
	"cost_micros" integer,
	"chargeable_cost_micros" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_route_id_ai_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."ai_routes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_user_day" ON "usage_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_day" ON "usage_events" USING btree ("created_at");