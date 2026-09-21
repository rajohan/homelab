import { useRef, useState, type ReactNode } from "react";

import { cn } from "../../lib/classNames";
import {
    InfiniteScrollTrigger,
    type InfiniteScrollContinuation,
} from "../InfiniteScrollTrigger/InfiniteScrollTrigger";
import { Virtualizer } from "../Virtualizer/Virtualizer";
import { DataTableRow } from "./DataTableRow";
import { TableSortButton } from "./TableSortButton";
import {
    compareTableValues,
    nextTableSort,
    type TableSort,
    type TableSortValue,
} from "./tableSorting";

export interface DataColumn<T> {
    readonly id: string;
    readonly label: string;
    readonly render: (row: T) => ReactNode;
    readonly sortValue?: (row: T) => TableSortValue;
    readonly mobile?: "title" | "wide" | "actions" | "footer-actions" | "hidden";
    readonly hideLabel?: boolean;
    readonly width?: string;
}

export interface DataRowAction<T> {
    readonly label: (row: T) => string;
    readonly onSelect: (row: T) => void;
}

/**
 * Display a responsive, virtualized data table with optional cursor-driven continuation.
 * @returns A labelled table which becomes stacked labelled rows on narrow containers.
 */
export function DataTable<T>({
    label,
    rows,
    columns,
    getKey,
    continuation,
    compact = false,
    rowAction,
    className,
    sort,
    onSortChange,
}: {
    readonly label: string;
    readonly rows: readonly T[];
    readonly columns: readonly DataColumn<T>[];
    readonly getKey: (row: T) => string;
    readonly continuation?: InfiniteScrollContinuation;
    readonly compact?: boolean;
    readonly rowAction?: DataRowAction<T>;
    readonly className?: string;
    readonly sort?: TableSort | null;
    readonly onSortChange?: (sort: TableSort | null) => void;
}) {
    const scrollRef = useRef<HTMLElement>(null);
    const [localSort, setLocalSort] = useState<TableSort | null>(null);
    const selectedSort = sort === undefined ? localSort : sort;
    const sortedColumn = columns.find((column) => column.id === selectedSort?.id);
    // Paged callers own ordering on the server, across every page. Never reorder
    // only the loaded subset and present it as a globally sorted inventory.
    const displayedRows =
        onSortChange || !selectedSort || !sortedColumn?.sortValue
            ? rows
            : rows.toSorted((left, right) =>
                  compareTableValues(
                      sortedColumn.sortValue!(left),
                      sortedColumn.sortValue!(right),
                      selectedSort.direction
                  )
              );
    const selectSort = (id: string) => {
        const next = nextTableSort(selectedSort, id);
        if (onSortChange) onSortChange(next);
        else setLocalSort(next);
        scrollRef.current?.scrollTo({ top: 0 });
    };
    return (
        <div className="@container min-w-0">
            <section
                ref={scrollRef}
                tabIndex={0}
                aria-label={label}
                className={cn(
                    "isolate max-h-[min(32.5rem,60dvh)] scrollbar-gutter-stable overflow-auto rounded-lg border border-primary-700 focus-visible:outline-2 focus-visible:outline-accent-500",
                    className
                )}
            >
                <Virtualizer
                    count={displayedRows.length}
                    scrollRef={scrollRef}
                    getKey={(index) => {
                        const row = displayedRows[index];
                        return row ? getKey(row) : String(index);
                    }}
                >
                    {({ items, totalSize, measureElement }) => (
                        <table
                            aria-label={label}
                            className="w-full table-fixed border-separate border-spacing-0 bg-primary-950/40 text-sm @max-[48rem]:block"
                        >
                            <thead className="sticky top-0 z-10 bg-primary-900 text-left text-xs text-primary-400 @max-[48rem]:sr-only">
                                <tr>
                                    {columns.map((column) => (
                                        <th
                                            key={column.id}
                                            scope="col"
                                            aria-sort={
                                                selectedSort?.id === column.id
                                                    ? selectedSort.direction
                                                    : undefined
                                            }
                                            className={cn(
                                                "border-b border-primary-700 p-3 font-medium",
                                                column.width
                                            )}
                                        >
                                            {column.sortValue &&
                                            (!continuation || onSortChange) ? (
                                                <TableSortButton
                                                    label={column.label}
                                                    direction={
                                                        selectedSort?.id === column.id
                                                            ? selectedSort.direction
                                                            : undefined
                                                    }
                                                    onClick={() => selectSort(column.id)}
                                                />
                                            ) : (
                                                <span
                                                    className={
                                                        column.hideLabel
                                                            ? "sr-only"
                                                            : undefined
                                                    }
                                                >
                                                    {column.label}
                                                </span>
                                            )}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="@max-[48rem]:block">
                                <tr aria-hidden="true" className="@max-[48rem]:block">
                                    <td
                                        colSpan={columns.length}
                                        style={{ height: items[0]?.start ?? 0 }}
                                    />
                                </tr>
                                {items.map((item) => {
                                    const row = displayedRows[item.index];
                                    return row === undefined ? null : (
                                        <DataTableRow
                                            key={item.key}
                                            row={row}
                                            index={item.index}
                                            measureElement={measureElement}
                                            columns={columns}
                                            compact={compact}
                                            {...(rowAction === undefined
                                                ? {}
                                                : { rowAction })}
                                        />
                                    );
                                })}
                                <tr aria-hidden="true" className="@max-[48rem]:block">
                                    <td
                                        colSpan={columns.length}
                                        style={{
                                            height: Math.max(
                                                0,
                                                totalSize - (items.at(-1)?.end ?? 0)
                                            ),
                                        }}
                                    />
                                </tr>
                            </tbody>
                        </table>
                    )}
                </Virtualizer>
                {continuation && (
                    <InfiniteScrollTrigger
                        rootRef={scrollRef}
                        itemCount={rows.length}
                        {...continuation}
                    />
                )}
            </section>
        </div>
    );
}
