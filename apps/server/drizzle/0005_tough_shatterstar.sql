CREATE TABLE "sync_items" (
	"space_id" uuid NOT NULL,
	"collection" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"deleted" boolean NOT NULL,
	"hlc" text NOT NULL,
	"device_id" uuid,
	"seq" bigint NOT NULL,
	"bytes" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_items_space_id_collection_key_pk" PRIMARY KEY("space_id","collection","key")
);
--> statement-breakpoint
CREATE TABLE "sync_pushes" (
	"space_id" uuid NOT NULL,
	"push_id" uuid NOT NULL,
	"device_id" uuid,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_pushes_space_id_push_id_pk" PRIMARY KEY("space_id","push_id")
);
--> statement-breakpoint
CREATE TABLE "sync_spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"epoch" uuid DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"bytes_used" integer DEFAULT 0 NOT NULL,
	"gc_floor_seq" bigint DEFAULT 0 NOT NULL,
	"gc_floor_hlc" text DEFAULT '000000000:0000:0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_spaces_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "sync_items" ADD CONSTRAINT "sync_items_space_id_sync_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."sync_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_items" ADD CONSTRAINT "sync_items_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_pushes" ADD CONSTRAINT "sync_pushes_space_id_sync_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."sync_spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_pushes" ADD CONSTRAINT "sync_pushes_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_spaces" ADD CONSTRAINT "sync_spaces_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_items_space_seq" ON "sync_items" USING btree ("space_id","seq");--> statement-breakpoint
CREATE INDEX "sync_items_tombstones" ON "sync_items" USING btree ("updated_at") WHERE "sync_items"."deleted";--> statement-breakpoint
CREATE INDEX "sync_pushes_created" ON "sync_pushes" USING btree ("created_at");