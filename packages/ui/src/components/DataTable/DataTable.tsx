import { useRef, type ReactNode } from "react";

import {
    InfiniteScrollTrigger,
    type InfiniteScrollContinuation,
} from "../InfiniteScrollTrigger/InfiniteScrollTrigger";
import { Virtualizer } from "../Virtualizer/Virtualizer";

export interface DataColumn<T> {
    readonly id: string;
    readonly label: string;
    readonly render: (row: T) => ReactNode;
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
}: {
    readonly label: string;
    readonly rows: readonly T[];
    readonly columns: readonly DataColumn<T>[];
    readonly getKey: (row: T) => string;
    readonly continuation?: InfiniteScrollContinuation;
}) {
    const scrollRef = useRef<HTMLElement>(null);
    return (
        <div className="@container min-w-0">
            <section
                ref={scrollRef}
                tabIndex={0}
                aria-label={label}
                className="max-h-130 overflow-auto rounded-lg border border-primary-700 focus-visible:outline-2 focus-visible:outline-accent-500"
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
                                            className="border-b border-primary-700 p-3 font-medium"
                                        >
                                            {column.label}
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
                                        <tr
                                            ref={measureElement}
                                            data-index={item.index}
                                            key={item.key}
                                            className="align-top @max-[48rem]:block @max-[48rem]:border-b @max-[48rem]:border-primary-700"
                                        >
                                            {columns.map((column) => (
                                                <td
                                                    key={column.id}
                                                    className="border-b border-primary-700/60 p-3 wrap-anywhere @max-[48rem]:grid @max-[48rem]:grid-cols-1 @max-[48rem]:gap-1 @max-[48rem]:border-0 @max-[48rem]:py-2"
                                                >
                                                    <span
                                                        className="hidden text-xs font-medium text-primary-400 @max-[48rem]:block"
                                                        aria-hidden="true"
                                                    >
                                                        {column.label}
                                                    </span>
                                                    {column.render(row)}
                                                </td>
                                            ))}
                                        </tr>
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
                    <InfiniteScrollTrigger rootRef={scrollRef} {...continuation} />
                )}
            </section>
        </div>
    );
}
