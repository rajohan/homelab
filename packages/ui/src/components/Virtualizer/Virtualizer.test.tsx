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
