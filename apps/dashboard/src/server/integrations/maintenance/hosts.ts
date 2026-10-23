import { hostResourceKey } from "../../jobs/resources";
import type { UpdateTarget } from "../updates/configuration";
import type { MaintenanceTarget } from "./configuration";

/**
 * Group restart recipes by the same canonical host used for their execution leases.
 * @param targets - Reviewed restart recipes, including optional host restart labels.
 * @param connections - Scoped update authorities; SSH addresses and credentials stay private.
 * @returns Per-target opaque host IDs and public display labels, independent of input order.
 */
export function maintenanceHosts(
    targets: readonly MaintenanceTarget[],
    connections: readonly UpdateTarget[]
): Map<string, { id: string; label: string }> {
    const authorities = new Map(
        connections.map((connection) => [connection.id, connection])
    );
    const labels = new Map<string, string>();
    for (const connection of connections.toSorted((a, b) => a.id.localeCompare(b.id))) {
        const id = hostResourceKey(connection.host);
        if (!labels.has(id)) labels.set(id, connection.source);
    }
    const hostLabels = new Map<string, string>();
    for (const target of targets.toSorted((a, b) => a.id.localeCompare(b.id))) {
        const connection = authorities.get(target.connection);
        if (!connection) throw new Error("Maintenance connection is unavailable");
        const id = hostResourceKey(connection.host);
        if (target.kind === "host" && !hostLabels.has(id))
            hostLabels.set(id, target.label);
    }
    return new Map(
        targets.map((target) => {
            const connection = authorities.get(target.connection)!;
            const id = hostResourceKey(connection.host);
            return [target.id, { id, label: hostLabels.get(id) ?? labels.get(id)! }];
        })
    );
}
