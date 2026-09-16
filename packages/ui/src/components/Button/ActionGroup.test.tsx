import { expect, spyOn, test } from "bun:test";

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ActionGroup } from "./ActionGroup";
import { Button } from "./Button";

test.each([false, true])(
    "action order follows the responsive layout and keyboard order (wide: %s)",
    async (wide) => {
        const media = globalThis.matchMedia("(min-width: 30rem)");
        Object.defineProperty(media, "matches", { configurable: true, value: wide });
        const match = spyOn(globalThis, "matchMedia").mockReturnValue(media);
        const view = render(
            <ActionGroup>
                <Button>Approve</Button>
                <Button variant="secondary">Deny</Button>
            </ActionGroup>
        );
        try {
            const approve = screen.getByRole("button", { name: "Approve" });
            const deny = screen.getByRole("button", { name: "Deny" });
            expect(approve).toHaveClass("whitespace-nowrap");
            expect(deny).toHaveClass("whitespace-nowrap");
            const container = approve.parentElement;
            expect(container).toHaveClass(
                "flex-col",
                "[&>button]:w-full",
                "[&>button]:min-w-min",
                "min-[30rem]:flex-wrap",
                "min-[30rem]:flex-row",
                "min-[30rem]:[&>button]:flex-1",
                "min-[30rem]:[&>button:last-child]:flex-2"
            );
            expect(container?.firstElementChild).toBe(wide ? deny : approve);
            expect(container?.lastElementChild).toBe(wide ? approve : deny);
            const user = userEvent.setup();
            await user.tab();
            expect(wide ? deny : approve).toHaveFocus();
            await user.tab();
            expect(wide ? approve : deny).toHaveFocus();
            act(() => {
                Object.defineProperty(media, "matches", {
                    configurable: true,
                    value: !wide,
                });
                media.dispatchEvent(new Event("change"));
            });
            expect(container?.firstElementChild).toBe(wide ? approve : deny);
            expect(container?.lastElementChild).toBe(wide ? deny : approve);
            // Reordering preserves the original buttons and their focus.
            expect(screen.getByRole("button", { name: "Approve" })).toBe(approve);
            expect(screen.getByRole("button", { name: "Deny" })).toBe(deny);
        } finally {
            view.unmount();
            match.mockRestore();
        }
    }
);
