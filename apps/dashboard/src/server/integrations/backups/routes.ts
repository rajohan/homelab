import {
    snapshotPageSchema,
    type BackupCatalog,
    type BackupInventory,
} from "@homelab/contracts/backups";
import type { SQL } from "bun";

import { runOperation, trpc } from "../../api/trpc";
import { authorizedOperations } from "../../operations/authorization";
import { sortedInventory } from "../../operations/sortedInventory";

/**
 * Read the last successful backup inventory without accessing identity or backup payloads.
 * @param client - Dashboard-only database connection.
 * @returns Stored observation or null before first successful collection.
 */
export async function readBackupInventory(client: SQL): Promise<BackupInventory | null> {
    const [row] = await client<
        { value: BackupInventory }[]
    >`SELECT value FROM operation_snapshots WHERE key = 'backups'`;
    return row?.value ?? null;
}
export const backupsRouter = trpc.router({
    catalog: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "backups:read");
            const [row] = await operations.client<
                { value: Omit<BackupCatalog, "snapshots">; stale: boolean }[]
            >`SELECT value - 'snapshots' AS value, captured_at < now() - interval '15 minutes' AS stale FROM operation_snapshots WHERE key = 'backups.catalog'`;
            return {
                configured: Boolean(operations.backupCatalog),
                inventory: row?.value ?? null,
                stale: row?.stale ?? true,
            };
        })
    ),
    snapshots: trpc.procedure.input(snapshotPageSchema).query(({ ctx, input }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "backups:read");
            const [row] = await operations.client<
                { value: BackupCatalog; stale: boolean }[]
            >`SELECT value, captured_at < now() - interval '15 minutes' AS stale FROM operation_snapshots WHERE key = 'backups.catalog'`;
            const snapshots =
                row?.value.snapshots.filter(
                    (snapshot) =>
                        snapshot.groupId === input.groupId &&
                        (input.sort ||
                            !input.before ||
                            Date.parse(snapshot.createdAt) < Date.parse(input.before))
                ) ?? [];
            const unknown = !operations.backupCatalog || !row || row.stale;
            const sorted = input.sort
                ? sortedInventory(
                      snapshots,
                      {
                          created: (item) => item.createdAt,
                          size: (item) => item.sizeBytes,
                          verification: (item) => (unknown ? null : item.verification),
                          protected: (item) => (unknown ? null : item.protected),
                      },
                      input.sort,
                      input.cursor,
                      input.limit
                  )
                : null;
            return {
                snapshots: sorted?.items ?? snapshots.slice(0, input.limit),
                nextSortCursor: sorted?.nextSortCursor ?? null,
                stale: row?.stale ?? true,
                nextCursor:
                    snapshots.length > input.limit
                        ? (snapshots.at(input.limit - 1)?.createdAt ?? null)
                        : null,
            };
        })
    ),
    inventory: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "backups:read");
            const [row] = await operations.client<
                { value: BackupInventory; stale: boolean }[]
            >`SELECT value, captured_at < now() - interval '3 minutes' AS stale FROM operation_snapshots WHERE key = 'backups'`;
            return {
                configured: Boolean(operations.metrics),
                inventory: row?.value ?? null,
                stale: row?.stale ?? true,
            };
        })
    ),
});
