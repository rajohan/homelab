ALTER TABLE "mira_computers" DROP CONSTRAINT "mira_computers_credential_state", ADD CONSTRAINT "mira_computers_credential_state" CHECK (
        ("state"='pending' AND "pair_digest" IS NOT NULL AND "credential_digest" IS NULL AND "paired_at" IS NULL) OR
        ("state"='paired' AND "pair_digest" IS NULL AND "credential_digest" IS NOT NULL AND "paired_at" IS NOT NULL AND "installation_id" IS NOT NULL AND "platform" IS NOT NULL) OR
        ("state"='revoked' AND "pair_digest" IS NULL AND "credential_digest" IS NULL));