import { expect, mock, test } from "bun:test";

import { VirtualListStore } from "./VirtualListStore";

test("virtual layout exposes stable snapshots and bounded visible rows for large lists", () => {
    const store = new VirtualListStore(10_000, String);
    const first = store.getSnapshot();
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(25);
    expect(first.totalSize).toBe(880_000);
    expect(store.getSnapshot()).toBe(first);
    const listener = mock(() => {});
    const unsubscribe = store.subscribe(listener);
    store.configure(20_000, String, null);
    expect(store.getSnapshot()).not.toBe(first);
    expect(first.totalSize).toBe(880_000);
    expect(store.getSnapshot().totalSize).toBe(1_760_000);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    store.configure(0, String, null);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual({ items: [], totalSize: 0 });
    store.mount()();
});
