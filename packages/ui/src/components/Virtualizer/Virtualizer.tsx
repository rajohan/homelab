import {
    useEffect,
    useState,
    useSyncExternalStore,
    type ReactNode,
    type RefObject,
} from "react";

import { VirtualListStore, type VirtualSnapshot } from "./VirtualListStore";

export interface VirtualWindow extends VirtualSnapshot {
    readonly measureElement: (element: Element | null) => void;
}

/**
 * Window rows using immutable layout snapshots compatible with automatic memoization.
 * @returns The caller's rendering of visible rows, overscan and measured spacer sizes.
 */
export function Virtualizer({
    count,
    getKey,
    scrollRef,
    children,
}: {
    readonly count: number;
    readonly getKey: (index: number) => string;
    readonly scrollRef: RefObject<HTMLElement | null>;
    readonly children: (window: VirtualWindow) => ReactNode;
}) {
    const [store] = useState(() => new VirtualListStore(count, getKey));
    // Parent DOM refs are committed before passive effects, not before child layout effects.
    useEffect(() => store.mount(), [store]);
    useEffect(
        () => store.configure(count, getKey, scrollRef.current),
        [store, count, getKey, scrollRef]
    );
    const snapshot = useSyncExternalStore(
        store.subscribe,
        store.getSnapshot,
        store.getSnapshot
    );
    return children({ ...snapshot, measureElement: store.measureElement });
}
