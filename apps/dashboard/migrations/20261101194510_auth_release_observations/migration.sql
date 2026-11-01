CREATE INDEX "release_deployments_auth_observations" ON "release_deployments" ("target", "configuration", "id" DESC) WHERE "receipt"->'auth'->>'state' = 'succeeded';
