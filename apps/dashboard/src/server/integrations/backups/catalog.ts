import type {
    BackupCatalog,
    BackupGroup,
    BackupSnapshot,
} from "@homelab/contracts/backups";
import * as v from "valibot";

import { readBoundedJson } from "../http/readJson";

export interface BackupCatalogConfiguration {
    readonly url: string;
    readonly token: string;
    readonly stores: readonly {
        readonly datastore: string;
        readonly namespace: string;
    }[];
}
const snapshotSchema = v.object({
    "backup-type": v.picklist(["vm", "ct", "host"]),
    "backup-id": v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/)),
    "backup-time": v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(8_000_000_000)
    ),
    size: v.optional(
        v.nullable(
            v.pipe(
                v.number(),
                v.integer(),
                v.minValue(0),
                v.maxValue(Number.MAX_SAFE_INTEGER)
            )
        )
    ),
    protected: v.optional(v.boolean(), false),
    verification: v.optional(v.nullable(v.object({ state: v.string() }))),
});
const schema = v.object({ data: v.pipe(v.array(snapshotSchema), v.maxLength(5000)) });

/**
 * List snapshot metadata from explicit PBS datastores/namespaces using an audit-only credential.
 * @param configuration - Server-owned endpoint, token and exact catalog scope.
 * @param signal - Collection deadline and cancellation.
 * @returns A complete bounded catalog, excluding backup contents, file lists, owners and comments.
 */
export async function readBackupCatalog(
    configuration: BackupCatalogConfiguration,
    signal: AbortSignal
): Promise<BackupCatalog> {
    const groups = new Map<string, BackupGroup>();
    const snapshots: BackupSnapshot[] = [];
    for (const store of configuration.stores) {
        const url = new URL(
            configuration.url.replace(/\/$/, "") +
                `/api2/json/admin/datastore/${encodeURIComponent(store.datastore)}/snapshots`
        );
        if (store.namespace) url.searchParams.set("ns", store.namespace);
        const response = await fetch(url, {
            signal,
            redirect: "error",
            headers: { Authorization: `PBSAPIToken=${configuration.token}` },
        });
        const data = v.parse(schema, await readBoundedJson(response));
        for (const row of data.data) {
            if (row["backup-time"] > Date.now() / 1000 + 60)
                throw new Error("Invalid snapshot timestamp");
            const name = `${row["backup-type"]}/${row["backup-id"]}`;
            const groupId = new Bun.CryptoHasher("sha256")
                .update(
                    JSON.stringify([
                        configuration.url,
                        store.datastore,
                        store.namespace,
                        name,
                    ])
                )
                .digest("hex");
            const createdAt = new Date(row["backup-time"] * 1000).toISOString();
            let verification: BackupSnapshot["verification"] = "unverified";
            if (row.verification?.state === "ok") verification = "verified";
            else if (row.verification?.state === "failed") verification = "failed";
            snapshots.push({
                id: `${groupId}:${row["backup-time"]}`,
                groupId,
                createdAt,
                sizeBytes: row.size ?? null,
                protected: row.protected,
                verification,
            });
            const previous = groups.get(groupId);
            const latest = !previous || createdAt > previous.latestAt;
            groups.set(groupId, {
                id: groupId,
                ...store,
                name,
                snapshotCount: (previous?.snapshotCount ?? 0) + 1,
                latestAt: latest ? createdAt : previous.latestAt,
                latestSizeBytes: latest ? (row.size ?? null) : previous.latestSizeBytes,
            });
        }
    }
    if (
        snapshots.length > 5000 ||
        new Set(snapshots.map((snapshot) => snapshot.id)).size !== snapshots.length
    )
        throw new Error("Invalid backup snapshot inventory");
    return {
        capturedAt: new Date().toISOString(),
        groups: [...groups.values()].toSorted(
            (a, b) =>
                a.datastore.localeCompare(b.datastore) ||
                a.namespace.localeCompare(b.namespace) ||
                a.name.localeCompare(b.name)
        ),
        snapshots: snapshots.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
}
