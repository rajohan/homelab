import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

// Schema tooling only. No credentials or connection to a database are configured.
export default defineConfig({
    dialect: "postgresql",
    schema: fileURLToPath(new URL("src/server/database/schema.ts", import.meta.url)),
    out: fileURLToPath(new URL("migrations", import.meta.url)),
    breakpoints: true,
});
