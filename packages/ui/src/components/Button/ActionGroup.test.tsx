import { expect, test } from "bun:test";

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ActionGroup } from "./ActionGroup";
import { Button } from "./Button";

test("actions follow their container width, preserving keyboard order and focus", async () => {
    let resize: ((width: number) => void) | undefined;
    let disconnected = false;
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class implements ResizeObserver {
        /** Capture deliveries so the test controls container resizing. */
        constructor(callback: ResizeObserverCallback) {
            resize = (width) =>
                callback([{ contentRect: { width } } as ResizeObserverEntry], this);
        }
        /** No real layout is observed in the DOM fixture. */
        observe() {}
        /** The fixture owns only one element. */
        unobserve() {}
        /** Record cleanup when the action group unmounts. */
        disconnect() {
            disconnected = true;
        }
    };
    const view = render(
        <ActionGroup>
            <Button>Approve</Button>
            <Button variant="secondary">Deny</Button>
        </ActionGroup>
    );
    try {
        const approve = screen.getByRole("button", { name: "Approve" });
        const deny = screen.getByRole("button", { name: "Deny" });
        const container = approve.parentElement;
        act(() => resize?.(320));
        expect(container?.firstElementChild?.textContent).toBe("Approve");
        expect(container).toHaveClass("flex-col", "[&>:is(button,a)]:w-full");
        const user = userEvent.setup();
        await user.tab();
        expect(approve).toHaveFocus();
        await user.tab();
        expect(deny).toHaveFocus();
        act(() => resize?.(700));
        expect(container?.firstElementChild?.textContent).toBe("Deny");
        expect(container?.lastElementChild?.textContent).toBe("Approve");
        expect(deny).toHaveFocus();
        await user.tab();
        expect(approve).toHaveFocus();
        act(() => resize?.(320));
        expect(container?.firstElementChild?.textContent).toBe("Approve");
        expect(approve).toHaveFocus();
    } finally {
        view.unmount();
        globalThis.ResizeObserver = original;
    }
    expect(disconnected).toBe(true);
});
