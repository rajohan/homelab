import type { BackupRecord } from "@homelab/contracts/backups";
import type { InfrastructureHost } from "@homelab/contracts/infrastructure";

import type { MiraQuery } from "./context";

/** Read bounded operational evidence from the same worker snapshots as the dashboard.
 * @param query - Operations database connection. This reader performs no probes or writes.
 * @returns Dated measurements; an absent inventory has no observation time.
 */
export async function readDashboardObservations(query: MiraQuery) {
    type Snapshot<T> = { capturedAt: string; stale: boolean; records: T[] };
    const [hosts, backups, installed] = await Promise.all([
        query<Snapshot<InfrastructureHost>[]>`
            SELECT captured_at::text AS "capturedAt", captured_at < now()-interval '3 minutes' AS stale,
                value->'hosts' AS records FROM operation_snapshots
            WHERE key='infrastructure.inventory' AND jsonb_typeof(value->'hosts')='array'`,
        query<Snapshot<BackupRecord>[]>`
            SELECT captured_at::text AS "capturedAt", captured_at < now()-interval '3 minutes' AS stale,
                value->'backups' AS records FROM operation_snapshots
            WHERE key='backups' AND jsonb_typeof(value->'backups')='array'`,
        query<
            {
                source: string;
                capturedAt: string;
                stale: boolean;
                container: string;
                image: string;
                version: string | null;
            }[]
        >`
            WITH reports AS (
                SELECT substring(o.key FROM 9) AS source, o.value->>'capturedAt' AS captured,
                    o.captured_at < now()-interval '26 hours' OR o.value->>'complete' IS DISTINCT FROM 'true' AS stale,
                    CASE WHEN r.value->>'capturedAt'=o.value->>'capturedAt' AND r.captured_at>now()-interval '26 hours'
                        THEN r.value ELSE o.value END AS inventory
                FROM operation_snapshots o LEFT JOIN operation_snapshots r ON r.key='updates.resolved:'||substring(o.key FROM 9)
                WHERE o.key LIKE 'updates:%'
            )
            SELECT source, captured AS "capturedAt", stale, item->>'name' AS container,
                item->>'image' AS image, coalesce(item->>'installedVersion',
                    substring(split_part(item->>'image','@',1) FROM ':v?([0-9]+[.][0-9]+[.][0-9]+(?:[-+][0-9A-Za-z.+-]+)?)$')) AS version
            FROM reports JOIN operation_snapshots release ON release.key='homelab.release'
            CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(inventory->'items')='array'
                THEN inventory->'items' ELSE '[]'::jsonb END) item
            WHERE item->>'kind'='container' AND starts_with(lower(item->>'image'), 'ghcr.io/'||lower(release.value->>'repository')||'/')
            ORDER BY source, container LIMIT 101`,
    ]);
    const host = hosts[0],
        backup = backups[0];
    return {
        hosts: host
            ? {
                  capturedAt: host.capturedAt,
                  stale: host.stale,
                  total: host.records.length,
                  items: host.records
                      .slice(0, 100)
                      .map(({ name, kind, node, state }) => ({
                          name,
                          kind,
                          node,
                          state,
                      })),
              }
            : null,
        backups: backup
            ? {
                  capturedAt: backup.capturedAt,
                  stale: backup.stale,
                  total: backup.records.length,
                  items: backup.records
                      .slice(0, 100)
                      .map(
                          ({
                              host,
                              task,
                              state,
                              lastSuccessAt,
                              lastFailureAt,
                              maximumAgeSeconds,
                          }) => ({
                              host,
                              task,
                              state,
                              lastSuccessAt,
                              lastFailureAt,
                              maximumAgeSeconds,
                          })
                      ),
              }
            : null,
        installedHomelabContainers: {
            items: installed.slice(0, 100),
            truncated: installed.length > 100,
        },
    };
}
