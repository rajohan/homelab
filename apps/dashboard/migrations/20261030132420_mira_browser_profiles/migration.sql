CREATE TABLE "mira_browser_profiles" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"origins" jsonb NOT NULL,
	"host_id" uuid,
	"state" text DEFAULT 'active' NOT NULL,
	"storage" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_browser_profiles_name" CHECK (length("name") BETWEEN 1 AND 80),
	CONSTRAINT "mira_browser_profiles_state" CHECK ("state" IN ('active','deleting','deleted')),
	CONSTRAINT "mira_browser_profiles_storage" CHECK ("storage" IN ('new','creating','ready') AND ("storage"='new' OR "host_id" IS NOT NULL)),
	CONSTRAINT "mira_browser_profiles_origins" CHECK (jsonb_typeof("origins")='array' AND jsonb_array_length("origins") BETWEEN 1 AND 16 AND octet_length("origins"::text)<=65536)
);
--> statement-breakpoint
ALTER TABLE "mira_browser_access" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
CREATE INDEX "mira_browser_profiles_owner" ON "mira_browser_profiles" ("owner","state");--> statement-breakpoint
ALTER TABLE "mira_browser_access" ADD CONSTRAINT "mira_browser_access_profile_id_mira_browser_profiles_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "mira_browser_profiles"("id");