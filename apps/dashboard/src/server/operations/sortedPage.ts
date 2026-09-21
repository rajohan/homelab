import type { TableCursor, TableSort } from "@homelab/contracts/tableSort";
import type { SQL, TransactionSQL } from "bun";

import { OperationFailure } from "./errors";

/**
 * Apply bounded keyset pagination to a complete authorized SQL projection.
 * @param client - Dashboard database connection or transaction.
 * @param base - Code-owned query with authorization and filters, without pagination.
 * @param fields - Whitelisted public column to projected property mapping.
 * @param sort - Validated column and direction.
 * @param cursor - Previous value/ID boundary, independent of whether that row still exists.
 * @param limit - Validated page size.
 * @returns One page with a stable, nulls-last cursor and no internal sort projection.
 */
export async function sortedPage<T>(
    client: SQL | TransactionSQL,
    base: SQL.Query<unknown>,
    fields: Readonly<Record<string, string>>,
    sort: TableSort,
    cursor: TableCursor | undefined,
    limit: number
): Promise<{ items: T[]; nextSortCursor: TableCursor | null }> {
    const field = fields[sort.id];
    if (
        !field ||
        (cursor &&
            (cursor.sort.id !== sort.id || cursor.sort.direction !== sort.direction))
    )
        throw new OperationFailure(
            "BAD_REQUEST",
            "The sorting cursor does not match this table."
        );
    const direction = sort.direction === "ascending" ? client`ASC` : client`DESC`;
    const comparison = sort.direction === "ascending" ? client`>` : client`<`;
    const cursorValue =
        !cursor || cursor.value === null ? null : JSON.stringify(cursor.value);
    const result = await client<
        { data: T & { id: string }; value: TableCursor["value"] }[]
    >`
        WITH candidates AS (${base}), sort_values AS (
            SELECT to_jsonb(candidates) AS data, id, NULLIF(to_jsonb(candidates)->${field}, 'null'::jsonb) AS raw_value FROM candidates
        ), ordered AS (
            SELECT data, id, CASE WHEN jsonb_typeof(raw_value) = 'string' THEN to_jsonb(lower(raw_value #>> '{}')) ELSE raw_value END AS value FROM sort_values
        )
        SELECT data, value FROM ordered WHERE ${cursor?.id ?? null}::text IS NULL OR
            (value IS NULL AND (${cursorValue}::text::jsonb IS NOT NULL OR id::text > ${cursor?.id ?? null})) OR
            (value IS NOT NULL AND ${cursorValue}::text::jsonb IS NOT NULL AND (value ${comparison} ${cursorValue}::text::jsonb OR (value = ${cursorValue}::text::jsonb AND id::text > ${cursor?.id ?? null})))
        ORDER BY value ${direction} NULLS LAST, id ASC LIMIT ${limit + 1}`;
    const last = result.at(limit - 1);
    return {
        items: result.slice(0, limit).map((row) => row.data),
        nextSortCursor:
            result.length > limit && last
                ? { id: last.data.id, sort, value: last.value }
                : null,
    };
}
