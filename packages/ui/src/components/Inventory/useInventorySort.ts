import {
    compareTableValues,
    type TableSort,
    type TableSortValue,
} from "@homelab/contracts/tableSort";
import { useState } from "react";

export interface SortField<T> {
    readonly label: string;
    readonly value: (row: T) => TableSortValue;
}

/** Order inventory by a measured field while keeping missing readings last in both directions.
 * @param rows - Inventory entries in collection order.
 * @param fields - Sortable measurements and their field labels.
 * @param initialField - Initially selected label, defaulting to the first field.
 * @returns The ordered rows and controlled props for a SortControl.
 */
export function useInventorySort<T>(
    rows: readonly T[],
    fields: readonly [SortField<T>, ...SortField<T>[]],
    initialField = fields[0].label
) {
    const [sort, setSort] = useState<TableSort>({
        id: initialField,
        direction: "ascending",
    });
    const field = fields.find((item) => item.label === sort.id) ?? fields[0];
    const ordered = rows.toSorted((a, b) =>
        compareTableValues(field.value(a), field.value(b), sort.direction)
    );
    return {
        ordered,
        control: {
            sort,
            onChange: setSort,
            options: fields.map(({ label }) => ({ label, value: label })),
        },
    };
}
