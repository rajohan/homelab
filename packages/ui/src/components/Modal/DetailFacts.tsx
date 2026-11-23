import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/classNames";

const layouts = {
    grid: {
        list: "grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-x-5 gap-y-3",
        field: "min-w-0",
    },
    inline: {
        list: "flex flex-wrap items-baseline gap-x-4 gap-y-1",
        field: "flex min-w-0 flex-wrap items-baseline gap-x-1.5",
    },
    properties: {
        list: "grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-3 @min-[34rem]/properties:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] @min-[34rem]/properties:items-stretch",
        field: "col-span-full grid min-w-0 grid-cols-subgrid items-center @min-[34rem]/properties:col-span-1 @min-[34rem]/properties:flex @min-[34rem]/properties:flex-col @min-[34rem]/properties:items-start @min-[34rem]/properties:gap-1.5 @min-[34rem]/properties:not-first:border-s @min-[34rem]/properties:not-first:border-primary-700 @min-[34rem]/properties:not-first:ps-4",
    },
};

/** Display named readings in a compact definition list that flows with the available width.
 * @returns Values and their optional measurement context.
 */
export function DetailFacts({
    items,
    inline = false,
    layout = inline ? "inline" : "grid",
}: {
    readonly inline?: boolean;
    readonly layout?: keyof typeof layouts;
    readonly items: readonly {
        label: string;
        value: ReactNode;
        detail?: string;
        icon?: LucideIcon;
    }[];
}) {
    const properties = layout === "properties";
    const list = (
        <dl className={layouts[layout].list}>
            {items.map(({ label, value, detail, icon: Icon }) => (
                <div key={label} className={layouts[layout].field}>
                    <dt
                        className={cn(
                            "text-xs font-medium text-primary-400",
                            Icon && "flex items-center gap-2"
                        )}
                    >
                        {Icon && (
                            <Icon aria-hidden="true" size={15} className="shrink-0" />
                        )}
                        {label}
                    </dt>
                    <dd
                        className={cn(
                            "text-sm font-medium wrap-anywhere text-primary-100 tabular-nums",
                            properties
                                ? "min-w-0 @min-[34rem]/properties:text-base @min-[34rem]/properties:font-semibold"
                                : "mt-0.5"
                        )}
                    >
                        {value}
                    </dd>
                    {detail && (
                        <dd className="mt-0.5 text-xs leading-relaxed text-primary-400">
                            {detail}
                        </dd>
                    )}
                </div>
            ))}
        </dl>
    );
    return properties ? <div className="@container/properties">{list}</div> : list;
}
