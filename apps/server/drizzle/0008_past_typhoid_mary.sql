ALTER TABLE "refresh_tokens" ADD COLUMN "replaced_by" uuid;--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" USING btree ("expires_at");