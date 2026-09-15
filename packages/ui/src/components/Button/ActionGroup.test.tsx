import { expect, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ActionGroup } from "./ActionGroup";
import { Button } from "./Button";

test("primary actions keep the same keyboard and visual order when stacked", async () => {
    render(
        <ActionGroup>
            <Button>Approve</Button>
            <Button variant="secondary">Deny</Button>
        </ActionGroup>
    );
    const approve = screen.getByRole("button", { name: "Approve" });
    const deny = screen.getByRole("button", { name: "Deny" });
    expect(approve.parentElement).toHaveClass(
        "flex-col",
        "[&>button]:w-full",
        "min-[30rem]:flex-row",
        "min-[30rem]:flex-wrap"
    );
    expect(approve.parentElement?.firstElementChild).toBe(approve);
    expect(approve.nextElementSibling).toBe(deny);
    const user = userEvent.setup();
    await user.tab();
    expect(approve).toHaveFocus();
    await user.tab();
    expect(deny).toHaveFocus();
});
