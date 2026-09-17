import { expect, mock, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DatePicker } from "./DatePicker";

test("calendar selects a day, closes, and disallows dates before the minimum", async () => {
    const value = new Date(2026, 8, 17, 12);
    const change = mock((_value: Date) => {});
    const view = render(
        <DatePicker
            label="Resume date"
            value={value}
            minimumDate={value}
            onChange={change}
        />
    );
    try {
        const user = userEvent.setup();
        await user.click(
            screen.getByRole("button", {
                name: "Choose Resume date, selected 17.09.2026",
            })
        );
        const buttons = screen.getAllByRole("button");
        const selected = buttons.find((button) => button.textContent === "17");
        expect(selected).toHaveClass("rounded-full!");
        expect(selected?.closest("td")).toHaveClass("[&>button]:bg-accent-600!");
        expect(document.querySelector(".rdp-chevron")).toHaveClass("fill-white!");
        const previous = buttons.find((button) => button.textContent === "16");
        const next = buttons.find((button) => button.textContent === "21");
        expect(previous).toBeDisabled();
        if (!next) throw new Error("Expected calendar date");
        await user.click(next);
        expect(change).toHaveBeenLastCalledWith(new Date(2026, 8, 21, 12));
        expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    } finally {
        view.unmount();
    }
});
