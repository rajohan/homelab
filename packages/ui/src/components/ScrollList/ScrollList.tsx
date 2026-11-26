import { type ReactNode, useRef } from "react";

import { useOverlayScrollbars } from "../../hooks/useOverlayScrollbars";
import { cn } from "../../lib/classNames";
import {
    type InfiniteScrollContinuation,
    InfiniteScrollTrigger,
} from "../InfiniteScrollTrigger/InfiniteScrollTrigger";
import { Virtualizer } from "../Virtualizer/Virtualizer";

/**
 * Window measured list items and fetch cursor pages near the end of the list.
 * @returns A keyboard-scrollable list of cards or events at their natural heights.
 */
export function ScrollList<T>({
    label,
    rows,
    getKey,
    renderItem,
    continuation,
    className,
    itemClassName,
    framed = false,
}: {
    readonly label: string;
    readonly rows: readonly T[];
    readonly getKey: (row: T) => string;
    readonly renderItem: (row: T, index: number) => ReactNode;
    readonly continuation?: InfiniteScrollContinuation;
    readonly className?: string;
    readonly itemClassName?: string;
    readonly framed?: boolean;
}) {
    const scrollRef = useRef<HTMLElement>(null);
    useOverlayScrollbars(scrollRef);
    return (
        <div className="relative grid scroll-anchor-boundary">
            <section
                ref={scrollRef}
                aria-label={label}
                tabIndex={0}
                className={cn(
                    "max-h-[min(32.5rem,60dvh)] min-w-0 focus-visible:outline-2 focus-visible:outline-accent-500",
                    framed && rows.length > 0
                        ? "scroll-frame bg-surface-card"
                        : "overflow-auto rounded-lg",
                    continuation?.hasMore &&
                        (continuation.loading || continuation.refreshing) &&
                        "overscroll-y-contain",
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
                        <ul className="[overflow-anchor:none]">
                            <li
                                aria-hidden="true"
                                style={{ height: items[0]?.start ?? 0 }}
                            />
                            {items.map((item) => {
                                const row = rows[item.index];
                                return row === undefined ? null : (
                                    <li
                                        key={item.key}
                                        data-index={item.index}
                                        ref={measureElement}
                                        className={cn(
                                            !framed && "pb-3",
                                            framed &&
                                                item.index > 0 &&
                                                "border-t border-primary-700",
                                            itemClassName
                                        )}
                                    >
                                        {renderItem(row, item.index)}
                                    </li>
                                );
                            })}
                            <li
                                aria-hidden="true"
                                style={{
                                    height: Math.max(
                                        0,
                                        totalSize - (items.at(-1)?.end ?? 0)
                                    ),
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
        </div>
    );
}
