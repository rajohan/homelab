import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/bun-sql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

import type { DashboardConnection } from "./connection";

/**
 * Locate dashboard migrations in source or independently packaged application output.
 * @returns The owned migration directory.
 */
export function dashboardMigrationsFolder(): string {
    return fileURLToPath(
        new URL(
            existsSync(new URL("migrations", import.meta.url))
                ? "./migrations"
                : "../../../migrations",
            import.meta.url
        )
    );
}

/**
 * Apply committed dashboard schema changes as an explicit administrative operation.
 * @param connection - An explicitly selected dashboard database connection.
 * @returns Completion after migration application.
 */
export async function migrateDashboard(connection: DashboardConnection): Promise<void> {
    await migrate(connection.database, { migrationsFolder: dashboardMigrationsFolder() });
}

/**
 * Fail startup when the database schema is not exactly the version shipped with this build.
 * @param connection - The dashboard database connection to verify without writes.
 * @returns Completion when the migration inventory matches.
 */
export async function assertDashboardSchema(
    connection: DashboardConnection
): Promise<void> {
    const expected = readMigrationFiles({
        migrationsFolder: dashboardMigrationsFolder(),
    });
    const applied = await connection.client<
        { name: string; hash: string }[]
    >`SELECT name, hash FROM drizzle.__drizzle_migrations`;
    if (
        expected.length === 0 ||
        expected.length !== applied.length ||
        !expected.every((item) =>
            applied.some((row) => row.name === item.name && row.hash === item.hash)
        )
    )
        throw new Error("Dashboard migrations do not match this build");
}
