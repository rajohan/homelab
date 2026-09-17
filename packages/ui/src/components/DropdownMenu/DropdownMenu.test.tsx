import { expect, mock, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DropdownMenu } from "./DropdownMenu";

test("action menus support keyboard activation, closing and disabled actions", async () => {
    const run = mock(() => {});
    const remove = mock(() => {});
    const view = render(
        <DropdownMenu
            label="Job actions"
            actions={[
                { id: "run", label: "Run now", onSelect: run },
                {
                    id: "delete",
                    label: "Delete",
                    danger: true,
                    disabled: true,
                    onSelect: remove,
                },
            ]}
        />
    );
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Job actions" }));
        expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveAttribute(
            "aria-disabled",
            "true"
        );
        await user.keyboard("{ArrowDown}{Enter}");
        expect(run).toHaveBeenCalledTimes(1);
        expect(remove).not.toHaveBeenCalled();
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    } finally {
        view.unmount();
    }
});
