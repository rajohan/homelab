import type { ComponentProps, CSSProperties } from "react";

import { MetricStat } from "./MetricStat";

/** Group related counts on one surface, keeping each label with its reading as space changes.
 * @param props - A group name and the readings, including any status filters.
 * @returns A definition list with balanced columns on narrow and wide screens.
 */
export function SummaryStrip({
    items,
    label,
}: {
    readonly label?: string;
    readonly items: readonly Pick<
        ComponentProps<typeof MetricStat>,
        "label" | "value" | "detail" | "attention" | "tone" | "toggle"
    >[];
}) {
    if (items.length === 0) return null;
    const columns = Math.min(items.length, 6);
    const compactColumns = columns > 3 ? 2 : columns;
    return (
        <div className="@container/summary min-w-0">
            <dl
                aria-label={label}
                style={
                    {
                        "--compact-columns": compactColumns,
                        "--wide-columns": columns,
                    } as CSSProperties
                }
                className="grid grid-cols-[repeat(var(--compact-columns),minmax(0,1fr))] gap-1 rounded-lg bg-primary-800/65 p-1.5 @min-[48rem]/summary:grid-cols-[repeat(var(--wide-columns),minmax(0,1fr))]"
            >
                {items.map((item) => (
                    <MetricStat key={item.label} {...item} appearance="summary" />
                ))}
            </dl>
        </div>
    );
}
