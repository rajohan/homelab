import { type ReactNode, useRef } from "react";

import { useOverlayScrollbars } from "../../hooks/useOverlayScrollbars";
import { cn } from "../../lib/classNames";
import {
    type InfiniteScrollContinuation,
    InfiniteScrollTrigger,
} from "../InfiniteScrollTrigger/InfiniteScrollTrigger";

/**
 * Keep loaded items in reading order and fetch cursor pages near the end of the list.
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
        <div className="grid scroll-anchor-boundary">
            <section
                ref={scrollRef}
                aria-label={label}
                tabIndex={0}
                className={cn(
                    "max-h-[min(32.5rem,60dvh)] min-w-0 focus-visible:outline-2 focus-visible:outline-accent-500",
                    framed && rows.length > 0
                        ? "scroll-frame bg-surface-card"
                        : "overflow-auto rounded-lg",
                    className
                )}
            >
                <ul>
                    {rows.map((row, index) => (
                        <li
                            key={getKey(row)}
                            data-index={index}
                            className={cn(
                                !framed && "pb-3",
                                framed && index > 0 && "border-t border-primary-700",
                                itemClassName
                            )}
                        >
                            {renderItem(row, index)}
                        </li>
                    ))}
                </ul>
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
