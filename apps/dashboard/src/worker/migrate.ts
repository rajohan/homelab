import { dashboardOperationsConfiguration } from "../server/config/environment";
import { connectDashboardDatabase } from "../server/database/connection";
import { migrateDashboard } from "../server/database/migrations";

/**
 * Run explicitly requested migrations without starting HTTP or worker processes.
 * @returns Completion after applying the committed schema and closing the pool.
 */
export async function main(): Promise<void> {
    if (process.argv[2] !== "--apply")
        throw new Error(
            "Use dashboard:migrate --apply with the intended dashboard database configured"
        );
    const configuration = dashboardOperationsConfiguration();
    if (!configuration) throw new Error("Dashboard database configuration is required");
    const connection = connectDashboardDatabase(configuration.databaseUrl, 1);
    try {
        await migrateDashboard(connection);
    } finally {
        await connection.client.close();
    }
}
if (import.meta.main) await main();
