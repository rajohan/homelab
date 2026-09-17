import {
    Virtualizer,
    elementScroll,
    observeElementOffset,
    observeElementRect,
    type VirtualItem,
} from "@tanstack/virtual-core";

export interface VirtualSnapshot {
    readonly items: readonly VirtualItem[];
    readonly totalSize: number;
}

/**
 * Bridge TanStack's mutable virtualizer to immutable React external-store snapshots.
 * The React adapter still exposes mutable-instance reads during render:
 * https://github.com/TanStack/virtual/discussions/1196
 */
export class VirtualListStore {
    readonly #listeners = new Set<() => void>();
    readonly #virtualizer: Virtualizer<HTMLElement, Element>;
    #snapshot: VirtualSnapshot;

    /**
     * Prepare the shared layout engine without attaching browser observers during render.
     * @param count - The initial item count.
     * @param getKey - Stable identity lookup for each row.
     */
    constructor(count: number, getKey: (index: number) => string) {
        this.#virtualizer = new Virtualizer<HTMLElement, Element>({
            count,
            getItemKey: getKey,
            getScrollElement: () => null,
            estimateSize: () => 88,
            overscan: 6,
            initialRect: { height: 520, width: 960 },
            observeElementRect,
            observeElementOffset,
            // Responsive row measurements update spacer sizes. Commit those changes
            // outside ResizeObserver delivery to avoid a same-frame layout feedback loop.
            useAnimationFrameWithResizeObserver: true,
            scrollToFn: elementScroll,
            onChange: () => this.#publish(),
        });
        this.#snapshot = {
            items: this.#virtualizer.getVirtualItems(),
            totalSize: this.#virtualizer.getTotalSize(),
        };
    }

    #publish(): void {
        const items = this.#virtualizer.getVirtualItems(),
            totalSize = this.#virtualizer.getTotalSize();
        if (items === this.#snapshot.items && totalSize === this.#snapshot.totalSize)
            return;
        this.#snapshot = { items, totalSize };
        for (const listener of this.#listeners) listener();
    }

    /**
     * Read the last published layout without mutating the engine.
     * @returns The cached snapshot, changing identity only when layout changes.
     */
    getSnapshot = (): VirtualSnapshot => this.#snapshot;

    /**
     * Subscribe React to visible-range or measurement changes.
     * @param listener - Callback requesting an external-store snapshot check.
     * @returns Listener cleanup.
     */
    subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    /**
     * Attach the core engine using the same lifecycle as TanStack's framework adapters.
     * @returns Observer cleanup for unmount or React strict-effect replay.
     */
    mount(): () => void {
        return this.#virtualizer._didMount();
    }

    /**
     * Apply committed row options and attach or update scroll observation.
     * @param count - The current number of rows.
     * @param getKey - Current row identity lookup.
     * @param scrollElement - The committed scroll container.
     */
    configure(
        count: number,
        getKey: (index: number) => string,
        scrollElement: HTMLElement | null
    ): void {
        this.#virtualizer.setOptions({
            ...this.#virtualizer.options,
            count,
            getItemKey: getKey,
            getScrollElement: () => scrollElement,
        });
        this.#virtualizer._willUpdate();
        this.#publish();
    }

    /**
     * Measure a mounted row; its data-index attribute identifies the corresponding item.
     * @param element - The row element or null on unmount.
     */
    measureElement = (element: Element | null): void => {
        this.#virtualizer.measureElement(element);
    };
}
