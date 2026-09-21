import {
    compareTableValues,
    type TableCursor,
    type TableSort,
    type TableSortValue,
} from "@homelab/contracts/tableSort";

import { OperationFailure } from "./errors";

/**
 * Sort an entire bounded inventory before applying its keyset boundary.
 * @param rows - Complete authorized snapshot, not an already paginated subset.
 * @param fields - Code-owned column accessors returning raw scalar values.
 * @param sort - Validated column and direction.
 * @param cursor - Previous value/identity pair, or undefined for the first page.
 * @param limit - Validated page size.
 * @returns A stable page that does not need its cursor row to remain present.
 */
export function sortedInventory<T extends { readonly id: string }>(
    rows: readonly T[],
    fields: Readonly<Record<string, (row: T) => TableSortValue>>,
    sort: TableSort,
    cursor: TableCursor | undefined,
    limit: number
): { items: T[]; nextSortCursor: TableCursor | null } {
    const value = fields[sort.id];
    if (
        !value ||
        (cursor &&
            (cursor.sort.id !== sort.id || cursor.sort.direction !== sort.direction))
    )
        throw new OperationFailure(
            "BAD_REQUEST",
            "The sorting cursor does not match this table."
        );
    const compare = (
        left: TableSortValue,
        leftId: string,
        right: TableSortValue,
        rightId: string
    ) => {
        const result = compareTableValues(left, right, sort.direction);
        if (result !== 0 || leftId === rightId) return result;
        return leftId < rightId ? -1 : 1;
    };
    const selected = rows
        .filter(
            (row) => !cursor || compare(value(row), row.id, cursor.value, cursor.id) > 0
        )
        .toSorted((left, right) => compare(value(left), left.id, value(right), right.id));
    const items = selected.slice(0, limit);
    const last = items.at(-1);
    return {
        items,
        nextSortCursor:
            selected.length > limit && last
                ? { id: last.id, sort, value: value(last) ?? null }
                : null,
    };
}
