export type BackupState =
    | "healthy"
    | "running"
    | "failed"
    | "overdue"
    | "disabled"
    | "unknown";
export interface BackupRecord {
    readonly id: string;
    readonly host: string;
    readonly task: string;
    readonly state: BackupState;
    readonly lastSuccessAt: string | null;
    readonly lastFailureAt: string | null;
    readonly maximumAgeSeconds: number | null;
}
export interface BackupInventory {
    readonly capturedAt: string;
    readonly backups: readonly BackupRecord[];
}
import * as v from "valibot";

import { tableSortSchema, tableCursorSchema } from "./tableSort";

export interface BackupSnapshot {
    readonly id: string;
    readonly groupId: string;
    readonly createdAt: string;
    readonly sizeBytes: number | null;
    readonly protected: boolean;
    readonly verification: "verified" | "failed" | "unverified";
}
export interface BackupGroup {
    readonly id: string;
    readonly datastore: string;
    readonly namespace: string;
    readonly name: string;
    readonly snapshotCount: number;
    readonly latestAt: string;
    readonly latestSizeBytes: number | null;
}
export interface BackupCatalog {
    readonly capturedAt: string;
    readonly groups: readonly BackupGroup[];
    readonly snapshots: readonly BackupSnapshot[];
}
export const snapshotPageSchema = v.strictObject({
    sort: v.optional(tableSortSchema(["created", "size", "verification", "protected"])),
    cursor: v.optional(tableCursorSchema),
    groupId: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    before: v.optional(v.pipe(v.string(), v.isoTimestamp())),
    limit: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
        30
    ),
});
