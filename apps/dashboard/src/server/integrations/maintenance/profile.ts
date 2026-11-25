import catalog from "../../../../config/maintenance-targets.homelab.json";
import type { UpdateTarget } from "../updates/configuration";
import { parseMaintenanceTargets } from "./configuration";

/** Adopt release-owned restart methods for the selected Homelab installation, retaining local service recipes.
 * @param value - Operator-owned list of configured targets.
 * @param connections - Pinned update host connections on this installation.
 * @param profile - Explicit opt-in to the Homelab fleet's controller mappings.
 * @returns Validated restart targets; custom targets and health checks are retained.
 */
export function deploymentMaintenanceTargets(
    value: string | undefined,
    connections: readonly UpdateTarget[],
    profile: string | undefined
) {
    const targets = parseMaintenanceTargets(value, connections);
    if (!profile) return targets;
    if (profile !== "homelab") throw new Error("Unknown maintenance catalog profile.");
    const merged = targets.map((target) => {
        const shipped = catalog.find(
            (item) =>
                item.id === target.id &&
                item.connection === target.connection &&
                item.kind === target.kind &&
                item.service === target.service &&
                item.workerIndependent === target.workerIndependent
        );
        if (!shipped) return target;
        const usePoolProbe =
            target.id === "db-pgbouncer" &&
            JSON.stringify(target.health) ===
                JSON.stringify(["/usr/bin/pg_isready", "-h", "127.0.0.1", "-p", "5432"]);
        return {
            ...target,
            ...(shipped.proxmox && !target.proxmox ? { proxmox: shipped.proxmox } : {}),
            ...(shipped.physicalNode && target.physicalNode === undefined
                ? { physicalNode: true }
                : {}),
            ...(shipped.restartReportedServices &&
            target.restartReportedServices === undefined
                ? { restartReportedServices: true }
                : {}),
            ...(usePoolProbe ? { health: shipped.health } : {}),
        };
    });
    return parseMaintenanceTargets(JSON.stringify(merged), connections);
}
