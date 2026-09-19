import { expect, test } from "bun:test";

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";

import { Popover, type PopoverControl } from "./Popover";

test("shared popovers mount on demand and dismiss with Escape", async () => {
    render(
        <Popover label="Open tools" trigger="Tools">
            <button type="button">Panel action</button>
        </Popover>
    );
    expect(
        screen.queryByRole("button", { name: "Panel action" })
    ).not.toBeInTheDocument();
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Open tools" });
    await user.click(trigger);
    expect(screen.getByRole("button", { name: "Panel action" })).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Panel action" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Open tools" })).toHaveAttribute(
        "aria-expanded",
        "false"
    );
});

test("explicit open requests are idempotent and panel actions can close with focus restoration", async () => {
    const control = createRef<PopoverControl>();
    render(
        <Popover label="Worker activity" trigger="Worker" controlRef={control}>
            {({ close }) => (
                <button type="button" onClick={close}>
                    Open details
                </button>
            )}
        </Popover>
    );
    const trigger = screen.getByRole("button", { name: "Worker activity" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await act(() => {
        control.current?.open();
        return Promise.resolve();
    });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await act(() => {
        control.current?.open();
        return Promise.resolve();
    });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await userEvent.setup().click(screen.getByRole("button", { name: "Open details" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
});
