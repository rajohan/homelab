import { cn } from "../../lib/classNames";
import type { DataColumn, DataRowAction } from "./DataTable";

/**
 * Present a measured row as desktop cells or a compact two-column mobile card.
 * @returns A row with an optional full-surface details button and independent actions.
 */
export function DataTableRow<T>({
    row,
    index,
    columns,
    measureElement,
    compact,
    rowAction,
}: {
    readonly row: T;
    readonly index: number;
    readonly columns: readonly DataColumn<T>[];
    readonly measureElement: (element: Element | null) => void;
    readonly compact: boolean;
    readonly rowAction?: DataRowAction<T>;
}) {
    const hasActions = columns.some((column) => column.mobile === "actions");
    return (
        <tr
            ref={measureElement}
            data-index={index}
            className={cn(
                "relative isolate align-top @max-[48rem]:border-b @max-[48rem]:border-primary-700",
                compact
                    ? "@max-[48rem]:grid @max-[48rem]:grid-cols-2 @max-[48rem]:gap-3 @max-[48rem]:p-3"
                    : "@max-[48rem]:block"
            )}
        >
            {columns.map((column, columnIndex) => (
                <td
                    key={column.id}
                    className={cn(
                        "min-w-0 border-b border-primary-700/60 p-3 wrap-anywhere @max-[48rem]:border-0",
                        column.mobile === "actions" && "text-right",
                        compact
                            ? "@max-[48rem]:p-0"
                            : "@max-[48rem]:grid @max-[48rem]:grid-cols-1 @max-[48rem]:gap-1 @max-[48rem]:py-2",
                        compact && column.mobile === "wide" && "@max-[48rem]:col-span-2",
                        compact &&
                            column.mobile === "title" &&
                            cn(
                                "@max-[48rem]:row-start-1 @max-[48rem]:self-center @max-[48rem]:font-medium @max-[48rem]:text-primary-50",
                                !hasActions && "@max-[48rem]:col-span-2"
                            ),
                        compact &&
                            column.mobile === "actions" &&
                            "@max-[48rem]:col-start-2 @max-[48rem]:row-start-1 @max-[48rem]:justify-self-end"
                    )}
                >
                    {columnIndex === 0 && rowAction && (
                        <button
                            type="button"
                            aria-label={rowAction.label(row)}
                            onClick={() => rowAction.onSelect(row)}
                            className="absolute inset-0 z-0 cursor-pointer transition-colors hover:bg-primary-800/50 focus-visible:bg-primary-800/50 focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:outline-none focus-visible:ring-inset"
                        />
                    )}
                    <div
                        className={cn(
                            "relative z-10 min-w-0",
                            rowAction &&
                                column.mobile !== "actions" &&
                                "pointer-events-none"
                        )}
                    >
                        <span
                            className={cn(
                                "hidden text-xs font-medium text-primary-400",
                                column.hideLabel ||
                                    (compact &&
                                        (column.mobile === "title" ||
                                            column.mobile === "actions"))
                                    ? "sr-only"
                                    : "@max-[48rem]:mb-1 @max-[48rem]:block"
                            )}
                            aria-hidden="true"
                        >
                            {column.label}
                        </span>
                        {column.render(row)}
                    </div>
                </td>
            ))}
        </tr>
    );
}
