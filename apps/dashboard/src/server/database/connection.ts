import { SQL, type TransactionSQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

/**
 * Open the dashboard's bounded, independently owned PostgreSQL pool.
 * @param url - A dashboard database URL, never the identity database URL.
 * @param maximumConnections - The explicit connection budget for this process.
 * @returns SQL and Drizzle handles sharing one pool; the caller owns shutdown.
 */
export function connectDashboardDatabase(url: string, maximumConnections = 4) {
    const client = new SQL(url, {
        max: maximumConnections,
        idleTimeout: 20,
        connectionTimeout: 10,
    });
    return { client, database: drizzle({ client }) };
}
export type DashboardConnection = ReturnType<typeof connectDashboardDatabase>;
export type Transaction = TransactionSQL;
