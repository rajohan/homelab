import type {
    UpdateReport,
    UpdateSource,
    UpdateSourceStatus,
} from "@homelab/contracts/updates";
import type { SQL } from "bun";

/**
 * Read bounded source summaries without transferring complete package lists.
 * @param client - Dashboard state connection.
 * @param sources - Configured sources only; removed publishers are not exposed.
 * @returns Freshness, coverage and counts without executable actions.
 */
export async function readUpdateSources(
    client: SQL,
    sources: readonly UpdateSource[]
): Promise<UpdateSourceStatus[]> {
    const rows = await client<
        {
            key: string;
            value: NonNullable<UpdateSourceStatus["report"]>;
            stale: boolean;
        }[]
    >`
        SELECT key, (value - 'items') || jsonb_build_object(
            'total', jsonb_array_length(value->'items'),
            'available', (SELECT count(*) FROM jsonb_array_elements(value->'items') item WHERE item->>'status' = 'available'),
            'security', (SELECT count(*) FROM jsonb_array_elements(value->'items') item WHERE item->>'status' = 'available' AND item->>'security' = 'true')
        ) AS value, captured_at < now() - interval '26 hours' AS stale
        FROM operation_snapshots WHERE key LIKE 'updates:%' OR key LIKE 'updates.resolved:%'`;
    return sources.map((source) => {
        const row = rows.find((item) => item.key === `updates:${source.id}`);
        const resolved = rows.find(
            (item) =>
                item.key === `updates.resolved:${source.id}` &&
                item.value.capturedAt === row?.value.capturedAt &&
                !item.stale
        );
        const report = resolved?.value ?? row?.value ?? null;
        return {
            id: source.id,
            label: source.label,
            report,
            stale: (row?.stale ?? true) || staleUpdateReport(report),
        };
    });
}

/**
 * Assess publication completeness and the age of local repository metadata.
 * @param report - Source metadata, with or without its package list.
 * @returns True when the observation must not be represented as current.
 */
export function staleUpdateReport(report: Omit<UpdateReport, "items"> | null): boolean {
    return (
        !report?.complete ||
        Date.parse(report.capturedAt) < Date.now() - 26 * 3_600_000 ||
        Boolean(
            report.coveredKinds.includes("os") &&
            (!report.repositoryMetadataAt ||
                Date.parse(report.repositoryMetadataAt) < Date.now() - 48 * 3_600_000)
        )
    );
}

/**
 * Select one source's newest compatible resolution, never a superseded report.
 * @param client - Dashboard state connection.
 * @param source - Validated configured source identity.
 * @returns At most one bounded publisher report.
 */
export async function readUpdateReport(
    client: SQL,
    source: string
): Promise<UpdateReport | null> {
    const [row] = await client<{ value: UpdateReport }[]>`
        SELECT CASE WHEN resolved.value->>'capturedAt' = observed.value->>'capturedAt' AND resolved.captured_at > now() - interval '26 hours'
          THEN resolved.value ELSE observed.value END AS value
        FROM operation_snapshots observed LEFT JOIN operation_snapshots resolved ON resolved.key = ${`updates.resolved:${source}`}
        WHERE observed.key = ${`updates:${source}`}`;
    return row?.value ?? null;
}
