import { useRef, type ReactNode } from "react";

import { cn } from "../../lib/classNames";
import {
    InfiniteScrollTrigger,
    type InfiniteScrollContinuation,
} from "../InfiniteScrollTrigger/InfiniteScrollTrigger";
import { Virtualizer } from "../Virtualizer/Virtualizer";
import { DataTableRow } from "./DataTableRow";

export interface DataColumn<T> {
    readonly id: string;
    readonly label: string;
    readonly render: (row: T) => ReactNode;
    readonly mobile?: "title" | "wide" | "actions" | "footer-actions";
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
}: {
    readonly label: string;
    readonly rows: readonly T[];
    readonly columns: readonly DataColumn<T>[];
    readonly getKey: (row: T) => string;
    readonly continuation?: InfiniteScrollContinuation;
    readonly compact?: boolean;
    readonly rowAction?: DataRowAction<T>;
    readonly className?: string;
}) {
    const scrollRef = useRef<HTMLElement>(null);
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
                    count={rows.length}
                    scrollRef={scrollRef}
                    getKey={(index) => {
                        const row = rows[index];
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
                                            className={cn(
                                                "border-b border-primary-700 p-3 font-medium",
                                                column.width
                                            )}
                                        >
                                            <span
                                                className={
                                                    column.hideLabel
                                                        ? "sr-only"
                                                        : undefined
                                                }
                                            >
                                                {column.label}
                                            </span>
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
                                    const row = rows[item.index];
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
