import { existsSync } from "node:fs";

import { sql } from "drizzle-orm";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import * as v from "valibot";

import type { AuthDatabase } from "./connection";

export function authMigrationsFolder(): string {
    return new URL(
        existsSync(new URL("migrations", import.meta.url))
            ? "./migrations"
            : "../../../migrations",
        import.meta.url
    ).pathname;
}

export function requiredAuthMigrations(): MigrationMeta[] {
    const migrations = readMigrationFiles({ migrationsFolder: authMigrationsFolder() });
    if (migrations.length === 0)
        throw new Error("The auth migration inventory is missing");
    return migrations;
}

const appliedSchema = v.array(v.object({ name: v.string(), hash: v.string() }));

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
