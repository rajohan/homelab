import { type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { EmptyState } from "../EmptyState/EmptyState";
import { DetailSection } from "../Modal/DetailSection";
import { SortControl } from "./SortControl";
import { type SortField, useInventorySort } from "./useInventorySort";

/** Present a measured inventory as responsive list entries, keeping its typed sort options available.
 * @returns A named list and controls scoped to its own rows.
 */
export function DetailList<T>({
    title,
    icon,
    rows,
    anchor,
    getKey,
    sorts,
    render,
    description,
    actions,
    empty,
    defaultField,
    showSort = true,
}: {
    readonly icon?: LucideIcon;
    readonly title: string;
    readonly anchor?: string | undefined;
    readonly rows: readonly T[];
    readonly getKey: (row: T) => string;
    readonly sorts: readonly [SortField<T>, ...SortField<T>[]];
    readonly render: (row: T) => ReactNode;
    readonly description?: string | undefined;
    readonly actions?: ReactNode;
    readonly defaultField?: string;
    readonly showSort?: boolean;
    readonly empty: string;
}) {
    const { ordered, control } = useInventorySort(rows, sorts, defaultField);
    return (
        <DetailSection
            title={title}
            icon={icon}
            anchor={anchor}
            count={rows.length}
            description={description}
            actions={
                showSort &&
                rows.length > 1 && (
                    <SortControl label={title.toLowerCase()} {...control} />
                )
            }
        >
            {actions}
            {ordered.length > 0 ? (
                <ul
                    aria-label={title}
                    className="@container/entries divide-y divide-primary-700/70"
                >
                    {ordered.map((row) => (
                        <li
                            key={getKey(row)}
                            className="min-w-0 py-3 first:pt-0 last:pb-0"
                        >
                            {render(row)}
                        </li>
                    ))}
                </ul>
            ) : (
                <EmptyState message={empty} />
            )}
        </DetailSection>
    );
}
