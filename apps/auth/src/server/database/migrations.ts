import { existsSync } from "node:fs";

import { sql } from "drizzle-orm";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import * as v from "valibot";

import type { AuthDatabase } from "./connection";

/**
 * Locate migrations in either the source tree or the built auth package.
 * @returns The absolute migration directory path.
 */
export function authMigrationsFolder(): string {
    return new URL(
        existsSync(new URL("migrations", import.meta.url))
            ? "./migrations"
            : "../../../migrations",
        import.meta.url
    ).pathname;
}

/**
 * Load the schema inventory shipped with this auth build.
 * @returns The nonempty ordered migration inventory.
 * @throws {Error} The packaged migration inventory is missing.
 */
export function requiredAuthMigrations(): MigrationMeta[] {
    const migrations = readMigrationFiles({ migrationsFolder: authMigrationsFolder() });
    if (migrations.length === 0)
        throw new Error("The auth migration inventory is missing");
    return migrations;
}

const appliedSchema = v.array(v.object({ name: v.string(), hash: v.string() }));

/**
 * Require the applied database journal to match this build's migration inventory.
 * @param database - The auth database to inspect.
 * @param expected - The exact migrations required by the running build.
 * @returns Completion when all journal names and hashes agree.
 * @throws {Error} The schema journal is missing, outdated or otherwise inconsistent.
 */
export async function assertAuthSchemaReady(
    database: AuthDatabase,
    expected: readonly MigrationMeta[]
): Promise<void> {
    const applied = v.parse(
        appliedSchema,
        await database.execute(sql`SELECT name, hash FROM drizzle.__drizzle_migrations`)
    );
    if (
        expected.length === 0 ||
        applied.length !== expected.length ||
        !expected.every((migration) =>
            applied.some(
                (row) => row.name === migration.name && row.hash === migration.hash
            )
        )
    )
        throw new Error("The auth database migrations do not match the running build");
}
