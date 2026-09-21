import type {
    ApplicationInventory,
    ApplicationSelection,
    ManagedApplication,
} from "@homelab/contracts/applications";
import type { SQL } from "bun";

import type { Transaction } from "../../database/connection";
import { OperationFailure } from "../../operations/errors";
import { applicationInventoryByteLimit, applicationRevision } from "./inventory";

/**
 * Read the last worker snapshot without giving the web process Docker credentials.
 * @param client - Dashboard database connection or current queue transaction.
 * @returns The stored inventory and freshness computed entirely by the database clock.
 */
export async function readApplicationInventory(
    client: SQL | Transaction
): Promise<{ inventory: ApplicationInventory; fresh: boolean } | null> {
    // Reject older oversized snapshots before transferring them; JSONB's text rendering
    // includes whitespace, so allow twice the collector's compact JSON byte budget here.
    const [row] = await client<
        { value: ApplicationInventory; capturedAt: Date; fresh: boolean }[]
    >`SELECT value, captured_at AS "capturedAt", captured_at > statement_timestamp() - interval '2 minutes' AND captured_at <= statement_timestamp() AS fresh FROM operation_snapshots WHERE key='applications.inventory' AND octet_length(value::text) <= ${applicationInventoryByteLimit * 2}`;
    return row
        ? {
              inventory: { ...row.value, capturedAt: row.capturedAt.toISOString() },
              fresh: row.fresh,
          }
        : null;
}

/**
 * Resolve a saved selection only when the host is available and its snapshot is fresh.
 * @param inventory - Worker-owned, nonsecret metadata.
 * @param hostId - Registered host identity.
 * @param selection - Exact container or Compose project selection.
 * @param fresh - Freshness from the database read in the current admission transaction.
 * @returns The bounded selected applications; missing or stale state fails closed.
 */
export function selectApplications(
    inventory: ApplicationInventory | null,
    hostId: string,
    selection: ApplicationSelection,
    fresh: boolean
): readonly ManagedApplication[] {
    const host = inventory?.hosts.find((item) => item.id === hostId);
    if (!inventory || !host?.available || !fresh)
        throw new OperationFailure(
            "PRECONDITION_FAILED",
            "Application state is unavailable or stale. Refresh before trying again."
        );
    const rows = host.applications.filter((item) =>
        selection.kind === "container"
            ? item.containerId === selection.target
            : item.project === selection.target
    );
    {
        const root = rows[0];
        if (root) {
            const selected = new Set(rows.map((item) => item.containerId));
            for (let added = true; added;) {
                added = false;
                for (const item of host.applications) {
                    if (
                        selected.has(item.containerId) ||
                        !item.namespaceParents?.some((parent) => selected.has(parent))
                    )
                        continue;
                    if (item.project !== root.project)
                        throw new OperationFailure(
                            "PRECONDITION_FAILED",
                            "A shared namespace crosses project boundaries. Review this deployment before changing it."
                        );
                    rows.push(item);
                    selected.add(item.containerId);
                    added = true;
                }
            }
        }
    }
    if (rows.length === 0 || rows.length > 50)
        throw new OperationFailure(
            "NOT_FOUND",
            "The selected application group is unavailable or exceeds the action limit."
        );
    return rows;
}

/**
 * Bind an operation to exact observed container identities and generations.
 * @param applications - The complete selected group.
 * @param selection - Whether one container or the whole project is being confirmed.
 * @returns A stable revision changing when a container is replaced or changes state.
 */
export function selectionRevision(
    applications: readonly ManagedApplication[],
    selection: ApplicationSelection
): string {
    return selection.kind === "container" && applications.length === 1
        ? (applications[0]?.revision ?? "")
        : applicationRevision(
              applications
                  .map((item) => [item.containerId, item.revision])
                  .toSorted((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""))
          );
}
