import { expect } from "bun:test";

import { createTestDatabase } from "../../../../../tests/database";
import { connectDashboardDatabase } from "../database/connection";
import { migrateDashboard } from "../database/migrations";
import { maintenanceJob } from "../jobs/maintenance";
import { createJobRegistry } from "../jobs/registry";

/**
 * Create a per-test PostgreSQL database on the existing disposable test service.
 * @returns Isolated operation services and exact database cleanup.
 */
export async function operationFixture() {
    const allocation = await createTestDatabase();
    const connection = connectDashboardDatabase(allocation.url);
    try {
        await migrateDashboard(connection);
    } catch (error) {
        await connection.client.close();
        await allocation.close();
        throw error;
    }
    return {
        ...connection,
        url: allocation.url,
        registry: createJobRegistry([maintenanceJob(30)]),
        async close() {
            await connection.client.close();
            await allocation.close();
        },
    };
}

/**
 * Wait for an operation to fail and assert its public error without detached promises.
 * @param operation - The operation whose rejection is required.
 * @param message - Expected substring of the safe public error.
 * @returns Completion after checking the settled rejection.
 */
export async function expectOperationFailure(
    operation: Promise<unknown>,
    message: string
): Promise<void> {
    const failure = await operation.then(
        () => null,
        (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty("message", expect.stringContaining(message));
}
