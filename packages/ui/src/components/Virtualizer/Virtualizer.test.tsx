import { expect, mock, test } from "bun:test";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";

import { Virtualizer } from "./Virtualizer";
import { VirtualListStore } from "./VirtualListStore";

test("scrolling publishes a new visible range and unmount detaches observation", () => {
    const element = document.createElement("div");
    Object.defineProperty(element, "offsetHeight", { value: 520 });
    Object.defineProperty(element, "offsetWidth", { value: 960 });
    document.body.append(element);
    const store = new VirtualListStore(100, String);
    const listener = mock(() => {});
    const unsubscribe = store.subscribe(listener);
    const unmount = store.mount();
    try {
        store.configure(100, String, element);
        const first = store.getSnapshot();
        element.scrollTop = 6000;
        fireEvent.scroll(element);
        expect(store.getSnapshot()).not.toBe(first);
        expect(store.getSnapshot().items[0]?.index).toBeGreaterThan(50);
        expect(listener).toHaveBeenCalled();
    } finally {
        unsubscribe();
        unmount();
        element.remove();
    }
});

function MountedList() {
    const scrollRef = useRef<HTMLDivElement>(null);
    return (
        <div
            data-testid="scroll-container"
            ref={(element) => {
                scrollRef.current = element;
                if (element) {
                    Object.defineProperty(element, "offsetHeight", {
                        value: 520,
                        configurable: true,
                    });
                    Object.defineProperty(element, "offsetWidth", {
                        value: 960,
                        configurable: true,
                    });
                }
            }}
        >
            <Virtualizer count={100} getKey={String} scrollRef={scrollRef}>
                {({ items }) => (
                    <span data-testid="first-row">{items[0]?.index ?? -1}</span>
                )}
            </Virtualizer>
        </div>
    );
}

test("the React adapter connects after its parent scroll container is committed", async () => {
    const view = render(<MountedList />);
    try {
        const element = screen.getByTestId("scroll-container");
        expect(screen.getByTestId("first-row")).toHaveTextContent("0");
        element.scrollTop = 6000;
        fireEvent.scroll(element);
        await waitFor(() =>
            expect(Number(screen.getByTestId("first-row").textContent)).toBeGreaterThan(
                50
            )
        );
    } finally {
        view.unmount();
    }
});

test("resize measurements update spacers on the next frame rather than during observer delivery", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const target = frame.contentWindow;
    if (!target) throw new Error("Expected an isolated frame window");
    const callbacks = new Map<Element, ResizeObserverCallback>();
    Object.defineProperty(target, "ResizeObserver", {
        configurable: true,
        value: class {
            readonly #callback: ResizeObserverCallback;
            /**
             * Capture this observer's isolated measurement handler.
             * @param callback - Measurement handler invoked by the test.
             */
            constructor(callback: ResizeObserverCallback) {
                this.#callback = callback;
            }
            /**
             * Register an element for an explicit test measurement.
             * @param element - Row or viewport whose next resize the test delivers.
             */
            observe(element: Element) {
                callbacks.set(element, this.#callback);
            }
            /**
             * Stop delivering measurements for an element.
             * @param element - Element no longer observed by this instance.
             */
            unobserve(element: Element) {
                callbacks.delete(element);
            }
            /** Detach the observer's measurement callbacks from the isolated frame. */
            disconnect() {
                callbacks.clear();
            }
        },
    });
    const viewport = target.document.createElement("div");
    Object.defineProperties(viewport, {
        offsetHeight: { value: 520 },
        offsetWidth: { value: 960 },
    });
    const row = target.document.createElement("div");
    row.dataset.index = "0";
    viewport.append(row);
    target.document.body.append(viewport);
    const store = new VirtualListStore(1, String);
    const unmount = store.mount();
    try {
        store.configure(1, String, viewport);
        store.measureElement(row);
        const before = store.getSnapshot();
        const entry = {
            target: row,
            borderBoxSize: [{ blockSize: 144, inlineSize: 960 }],
        } as unknown as ResizeObserverEntry;
        const observer = { observe() {}, unobserve() {}, disconnect() {} };
        expect(callbacks.has(row)).toBe(true);
        callbacks.get(row)?.([entry], observer);
        expect(store.getSnapshot()).toBe(before);
        await waitFor(() => expect(store.getSnapshot().totalSize).toBe(144));
    } finally {
        unmount();
        frame.remove();
    }
});
