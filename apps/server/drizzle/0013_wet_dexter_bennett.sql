CREATE TABLE "claim_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"verdict" text NOT NULL,
	"citations" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "claim_cache_expires_at_idx" ON "claim_cache" USING btree ("expires_at");