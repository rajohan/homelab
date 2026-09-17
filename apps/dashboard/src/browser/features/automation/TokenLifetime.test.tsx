import { expect, mock, test } from "bun:test";

import { Fieldset } from "@headlessui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TokenLifetime } from "./TokenLifetime";

test("token lifetime is an explicit accessible choice and no expiry is never implicit", async () => {
    const change = mock((_days: number | null) => {});
    const view = render(<TokenLifetime value={90} onChange={change} />);
    expect(screen.getByRole("button", { name: "90 days" })).toHaveAttribute(
        "aria-pressed",
        "true"
    );
    const permanent = screen.getByRole("button", { name: "No expiry" });
    expect(permanent).toHaveAttribute("aria-pressed", "false");
    await userEvent.setup().click(permanent);
    expect(change).toHaveBeenLastCalledWith(null);
    view.rerender(
        <Fieldset disabled>
            <TokenLifetime value={null} onChange={change} />
        </Fieldset>
    );
    expect(screen.getByRole("button", { name: "No expiry" })).toBeDisabled();
});
