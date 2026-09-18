import { useRef, type ReactNode } from "react";

import { cn } from "../../lib/classNames";
import {
    InfiniteScrollTrigger,
    type InfiniteScrollContinuation,
} from "../InfiniteScrollTrigger/InfiniteScrollTrigger";
import { Virtualizer } from "./Virtualizer";

/**
 * Window variable-height cards or events and load cursor pages near the end of their viewport.
 * @returns A keyboard-scrollable list sharing the table's virtualization and continuation behavior.
 */
export function VirtualList<T>({
    label,
    rows,
    getKey,
    renderItem,
    continuation,
    className,
}: {
    readonly label: string;
    readonly rows: readonly T[];
    readonly getKey: (row: T) => string;
    readonly renderItem: (row: T) => ReactNode;
    readonly continuation?: InfiniteScrollContinuation;
    readonly className?: string;
}) {
    const scrollRef = useRef<HTMLElement>(null);
    return (
        <section
            ref={scrollRef}
            aria-label={label}
            tabIndex={0}
            className={cn(
                "max-h-[min(32.5rem,60dvh)] min-w-0 scrollbar-gutter-stable overflow-auto rounded-lg focus-visible:outline-2 focus-visible:outline-accent-500",
                className
            )}
        >
            <Virtualizer
                count={rows.length}
                scrollRef={scrollRef}
                getKey={(index) => {
                    const row = rows[index];
                    return row === undefined ? String(index) : getKey(row);
                }}
            >
                {({ items, totalSize, measureElement }) => (
                    <ul>
                        <li aria-hidden="true" style={{ height: items[0]?.start ?? 0 }} />
                        {items.map((item) => {
                            const row = rows[item.index];
                            return row === undefined ? null : (
                                <li
                                    key={item.key}
                                    data-index={item.index}
                                    ref={measureElement}
                                    className="pb-3"
                                >
                                    {renderItem(row)}
                                </li>
                            );
                        })}
                        <li
                            aria-hidden="true"
                            style={{
                                height: Math.max(0, totalSize - (items.at(-1)?.end ?? 0)),
                            }}
                        />
                    </ul>
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
    );
}
