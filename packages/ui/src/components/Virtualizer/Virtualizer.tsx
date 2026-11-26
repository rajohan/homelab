import {
    type ReactNode,
    type RefObject,
    useEffect,
    useEffectEvent,
    useLayoutEffect,
    useState,
    useSyncExternalStore,
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
    const attach = useEffectEvent(() =>
        store.configure(count, getKey, scrollRef.current)
    );
    // The parent scrollport ref is available after the initial commit.
    useEffect(() => {
        const cleanup = store.mount();
        attach();
        return cleanup;
    }, [store]);
    // Reconcile new row keys and offsets together before painting a live update.
    useLayoutEffect(() => {
        if (scrollRef.current) store.configure(count, getKey, scrollRef.current);
    }, [store, count, getKey, scrollRef]);
    const snapshot = useSyncExternalStore(
        store.subscribe,
        store.getSnapshot,
        store.getSnapshot
    );
    return children({ ...snapshot, measureElement: store.measureElement });
}
