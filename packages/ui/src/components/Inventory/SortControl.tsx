import type { TableSort } from "@homelab/contracts/tableSort";
import { ArrowDown, ArrowUp, ListFilter } from "lucide-react";

import { IconButton } from "../Button/IconButton";
import { Select } from "../Select/Select";

/** Pick a sort field and direction for the list named by the caller.
 * @returns A keyboard-accessible field picker and a direction button.
 */
export function SortControl({
    label,
    options,
    sort,
    onChange,
}: {
    readonly label: string;
    readonly options: readonly { label: string; value: string }[];
    readonly sort: TableSort;
    readonly onChange: (sort: TableSort) => void;
}) {
    const ascending = sort.direction === "ascending";
    const next = ascending ? "descending" : "ascending";
    const name = options.find((option) => option.value === sort.id)?.label;
    return (
        <fieldset
            aria-label={`Order ${label}`}
            className="flex max-w-full min-w-0 flex-wrap items-center gap-1"
        >
            <Select
                label={`Sort ${label} by ${name}`}
                compact
                icon={ListFilter}
                options={options}
                value={sort.id}
                onChange={(id) => onChange({ ...sort, id })}
            />
            <IconButton
                icon={ascending ? ArrowUp : ArrowDown}
                size="sm"
                label={`Sorted ${sort.direction}. Sort ${label} ${next}`}
                onClick={() => onChange({ ...sort, direction: next })}
                className="border border-primary-700 sm:size-9"
            />
        </fieldset>
    );
}
