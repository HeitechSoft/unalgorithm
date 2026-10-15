CREATE TABLE "ops_alerts" (
	"key" text PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_value" double precision,
	"notified_at" timestamp with time zone
);
