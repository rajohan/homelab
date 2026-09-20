CREATE TABLE "update_policies" (
	"target" text PRIMARY KEY,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"configuration" text NOT NULL,
	CONSTRAINT "update_policies_version" CHECK ("version" >= 1)
);
