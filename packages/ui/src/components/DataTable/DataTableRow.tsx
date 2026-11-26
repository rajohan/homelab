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
    const hasStatus = columns.some((column) => column.mobile === "status");
    const statusWithActions = hasStatus && hasActions;
    return (
        <tr
            ref={measureElement}
            data-index={index}
            className={cn(
                "relative isolate @max-3xl:border-b @max-3xl:border-primary-700",
                compact ? "align-middle" : "align-top",
                compact
                    ? cn(
                          "@max-3xl:p-3",
                          statusWithActions
                              ? "@max-3xl:status-action-grid"
                              : "@max-3xl:grid @max-3xl:grid-cols-2 @max-3xl:gap-3"
                      )
                    : "@max-3xl:block"
            )}
        >
            {columns.map((column, columnIndex) => {
                const isAction =
                    column.mobile === "actions" || column.mobile === "footer-actions";
                return (
                    <td
                        key={column.id}
                        data-slot={column.mobile}
                        className={cn(
                            "min-w-0 border-b border-primary-700 p-3 wrap-anywhere @max-3xl:border-0",
                            isAction && "text-right",
                            compact
                                ? "py-2 @max-3xl:p-0"
                                : "@max-3xl:grid @max-3xl:grid-cols-1 @max-3xl:gap-1 @max-3xl:py-2",
                            compact && column.mobile === "wide" && "@max-3xl:col-span-2",
                            compact &&
                                column.mobile === "title" &&
                                cn(
                                    "@max-3xl:font-medium @max-3xl:text-primary-50",
                                    !statusWithActions &&
                                        "@max-3xl:row-start-1 @max-3xl:self-center",
                                    !hasActions && !hasStatus && "@max-3xl:col-span-2"
                                ),
                            compact &&
                                !statusWithActions &&
                                column.mobile === "status" &&
                                "@max-3xl:col-start-2 @max-3xl:row-start-1 @max-3xl:self-center @max-3xl:justify-self-end",
                            compact &&
                                column.mobile === "actions" &&
                                cn(
                                    "py-1 @max-3xl:p-0",
                                    !statusWithActions &&
                                        "@max-3xl:col-start-2 @max-3xl:row-start-1 @max-3xl:justify-self-end"
                                ),
                            compact &&
                                column.mobile === "footer-actions" &&
                                "@max-3xl:order-last @max-3xl:col-span-2",
                            column.mobile === "hidden" && "@max-3xl:hidden"
                        )}
                    >
                        {columnIndex === 0 && rowAction && (
                            <button
                                type="button"
                                aria-label={rowAction.label(row)}
                                onClick={() => rowAction.onSelect(row)}
                                className="absolute inset-0 z-0 cursor-pointer hover:bg-accent-300/12 focus-visible:bg-accent-300/12 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-400 active:bg-accent-300/18"
                            />
                        )}
                        <div
                            className={cn(
                                "relative z-10 min-w-0",
                                rowAction && !isAction && "pointer-events-none"
                            )}
                        >
                            <span
                                className={cn(
                                    "hidden text-xs font-medium text-primary-400",
                                    column.hideLabel ||
                                        (compact &&
                                            (column.mobile === "title" ||
                                                column.mobile === "status" ||
                                                isAction))
                                        ? "sr-only"
                                        : "@max-3xl:mb-1 @max-3xl:block"
                                )}
                                aria-hidden="true"
                            >
                                {column.label}
                            </span>
                            {column.render(row)}
                        </div>
                    </td>
                );
            })}
        </tr>
    );
}
