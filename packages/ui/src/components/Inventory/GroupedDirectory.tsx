import { ChevronRight, Layers } from "lucide-react";
import { type ReactNode, useId } from "react";

import { HeadingLabel } from "../SectionHeader/HeadingLabel";
import { BreakableName } from "./BreakableName";

const directoryStyles = {
    shelves: {
        wrapper:
            "@container/directory grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] items-start gap-4",
        group: "min-w-0 rounded-xl border border-primary-700 bg-surface-card p-3 sm:p-4",
        items: "grid",
    },
    index: {
        wrapper: "@container/directory divide-y divide-primary-700",
        group: "grid min-w-0 content-start gap-x-5 gap-y-1 py-2.5 first:pt-0 last:pb-0 @min-[44rem]/directory:grid-cols-[12rem_minmax(0,1fr)]",
        items: "grid grid-cols-[repeat(auto-fill,minmax(min(100%,9.25rem),1fr))] content-start gap-x-2 @min-[35rem]/directory:grid-cols-[repeat(auto-fill,minmax(min(100%,13rem),1fr))]",
    },
    list: {
        wrapper: "@container/directory space-y-5",
        group: "min-w-0",
        items: "grid gap-x-5 @min-[42rem]/directory:grid-cols-2",
    },
};

interface DirectoryProps<T> {
    readonly layout?: "list" | "shelves" | "index";
    readonly ordered?: boolean;
    readonly groupInfo?: ReadonlyMap<
        string,
        { label: string; detail?: string; action?: ReactNode; total?: number }
    >;
    readonly items: readonly T[];
    readonly group: (item: T) => string;
    readonly getKey: (item: T) => string;
    readonly name: (item: T) => string;
    readonly detail: (item: T) => ReactNode;
    readonly status: (item: T) => ReactNode;
    readonly readings?: ((item: T) => ReactNode) | undefined;
    readonly actions?: (item: T) => ReactNode;
    readonly onSelect?: (item: T) => void;
}

/** Organize a real inventory by its named project, host or other monitored relationship.
 * @returns An alphabetized, responsive directory with optional detail and independent action controls.
 */
export function GroupedDirectory<T>({
    items,
    group,
    getKey,
    name,
    detail,
    status,
    actions,
    readings,
    onSelect,
    layout = "list",
    ordered = false,
    groupInfo,
}: DirectoryProps<T>) {
    const directoryId = useId();
    const style = directoryStyles[layout];
    const index = layout === "index";
    let itemClassName = index
        ? "flex min-w-0 items-center gap-1"
        : "flex min-w-0 items-center gap-1 border-b border-primary-700/70 py-0.5 last:border-0";
    if (readings)
        itemClassName =
            "grid min-w-0 items-center gap-x-5 gap-y-1 py-3 @min-[38rem]/directory:grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)]";
    if (readings && actions)
        itemClassName =
            "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-3 @min-[42rem]/directory:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_auto] @min-[42rem]/directory:gap-x-5";
    const groups = Map.groupBy(items, group);
    for (const key of groupInfo?.keys() ?? []) {
        if (!groups.has(key)) groups.set(key, []);
    }
    const grouped = ordered
        ? [...groups]
        : [...groups].toSorted(([a], [b]) => a.localeCompare(b));
    return (
        <div className={style.wrapper}>
            {grouped.map(([key, entries]) => {
                const info = groupInfo?.get(key);
                const title = info?.label ?? key;
                const members = ordered
                    ? entries
                    : entries.toSorted((a, b) => name(a).localeCompare(name(b)));
                return (
                    <section key={key} aria-label={title} className={style.group}>
                        <div
                            className={
                                index
                                    ? "self-start"
                                    : "mb-1 flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-primary-700 pb-2"
                            }
                        >
                            <h3
                                className={
                                    index
                                        ? "flex min-w-0 items-center gap-2 self-start px-1 py-2 text-sm font-semibold text-primary-200"
                                        : "flex min-w-0 flex-wrap items-center gap-2 px-1 text-lg font-semibold tracking-tight"
                                }
                            >
                                <HeadingLabel icon={Layers} size={17} className="gap-2">
                                    {title}
                                </HeadingLabel>
                                <span
                                    className={`text-xs font-medium text-primary-400 tabular-nums ${index ? "" : "ml-auto"}`}
                                >
                                    {info?.total !== undefined &&
                                    entries.length < info.total
                                        ? `${entries.length} of ${info.total}`
                                        : entries.length}
                                </span>
                                {info?.detail && (
                                    <span className="text-xs font-normal text-primary-400">
                                        {info.detail}
                                    </span>
                                )}
                            </h3>
                            {info?.action}
                        </div>
                        <ul
                            className={
                                readings
                                    ? "grid divide-y divide-primary-700/70"
                                    : style.items
                            }
                        >
                            {members.map((item) => {
                                const descriptionId = `${directoryId}-${encodeURIComponent(getKey(item))}`;
                                const content = (
                                    <>
                                        <span className="min-w-0 flex-1">
                                            <span className="block font-semibold wrap-anywhere text-primary-50">
                                                <BreakableName>
                                                    {name(item)}
                                                </BreakableName>
                                            </span>
                                            <span
                                                id={descriptionId + "-detail"}
                                                className={`block text-xs wrap-anywhere text-primary-400 ${index ? "leading-tight" : "mt-0.5 leading-relaxed"}`}
                                            >
                                                {detail(item)}
                                            </span>
                                        </span>
                                        <span
                                            id={descriptionId + "-state"}
                                            className={
                                                index
                                                    ? "order-first shrink-0"
                                                    : "min-w-0 text-xs"
                                            }
                                        >
                                            {status(item)}
                                        </span>
                                    </>
                                );
                                return (
                                    <li key={getKey(item)} className={itemClassName}>
                                        {onSelect ? (
                                            <button
                                                type="button"
                                                aria-label={`Inspect ${name(item)}`}
                                                aria-describedby={`${descriptionId}-detail ${descriptionId}-state`}
                                                onClick={() => onSelect(item)}
                                                className={`group flex min-w-0 flex-1 items-center gap-2 rounded-md text-left text-sm hover:bg-primary-800 focus-visible:outline-2 focus-visible:outline-accent-300 ${index ? "min-h-11 px-2 py-1" : "min-h-14 p-2"}`}
                                            >
                                                {content}
                                                {!index && (
                                                    <ChevronRight
                                                        size={15}
                                                        aria-hidden="true"
                                                        className="shrink-0 text-primary-400 group-hover:text-accent-300"
                                                    />
                                                )}
                                            </button>
                                        ) : (
                                            <div className="flex min-h-14 min-w-0 flex-1 items-center gap-2 p-2 text-sm">
                                                {content}
                                            </div>
                                        )}
                                        {readings && actions ? (
                                            <>
                                                <div className="col-start-2 row-start-1 justify-self-end @min-[42rem]/directory:col-start-3">
                                                    {actions(item)}
                                                </div>
                                                <div className="col-span-2 min-w-0 @min-[42rem]/directory:col-span-1 @min-[42rem]/directory:col-start-2 @min-[42rem]/directory:row-start-1">
                                                    {readings(item)}
                                                </div>
                                            </>
                                        ) : (
                                            <>
                                                {readings?.(item)}
                                                {actions?.(item)}
                                            </>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                );
            })}
        </div>
    );
}
