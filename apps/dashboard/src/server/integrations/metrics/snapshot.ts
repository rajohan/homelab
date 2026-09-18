import type { InfrastructureInventory } from "@homelab/contracts/infrastructure";
import type { SQL } from "bun";

/**
 * Load the worker's saved identity baseline without writing polling results to PostgreSQL.
 * @param client - The scoped dashboard database connection.
 * @returns The most recent persisted inventory, or null before the first successful collection.
 */
export async function readSavedInventory(
    client: SQL
): Promise<InfrastructureInventory | null> {
    const rows = await client<
        { value: InfrastructureInventory }[]
    >`SELECT value FROM operation_snapshots WHERE key = 'infrastructure.inventory'`;
    return rows[0]?.value ?? null;
}
