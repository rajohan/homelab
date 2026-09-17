import { expect, mock, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TimePicker } from "./TimePicker";

test("time picker selects 24-hour segments and propagates field validation", async () => {
    const change = mock((_value: string) => {});
    const view = render(
        <TimePicker
            label="Run at"
            value="05:30"
            onChange={change}
            error="Choose a valid time."
        />
    );
    try {
        const user = userEvent.setup();
        const hour = screen.getByRole("button", { name: "Run at, hour" });
        expect(hour).toHaveAttribute("data-invalid");
        expect(screen.getByRole("group", { name: "Run at" })).toHaveAccessibleDescription(
            "Choose a valid time."
        );
        await user.click(hour);
        await user.click(screen.getByRole("option", { name: "23" }));
        expect(change).toHaveBeenLastCalledWith("23:30");
        view.rerender(<TimePicker label="Run at" value="23:30" onChange={change} />);
        await user.click(screen.getByRole("button", { name: "Run at, minute" }));
        await user.click(screen.getByRole("option", { name: "45" }));
        expect(change).toHaveBeenLastCalledWith("23:45");
        view.rerender(
            <TimePicker label="Run at" value="23:45" onChange={change} disabled />
        );
        expect(screen.getByRole("button", { name: "Run at, hour" })).toBeDisabled();
    } finally {
        view.unmount();
    }
});
