import { expect, mock, test } from "bun:test";

import { Fieldset } from "@headlessui/react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Switch } from "./Switch";

test("label and keyboard toggle the accessible controlled switch", async () => {
    const user = userEvent.setup();
    const change = mock(() => {});
    const view = render(
        <Switch
            label="Remember me"
            checked={false}
            onChange={change}
            description="Keep this browser signed in."
        />
    );
    const toggle = screen.getByRole("switch", { name: "Remember me" });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription("Keep this browser signed in.");
    expect(toggle.parentElement).toHaveClass("w-full", "justify-between");
    await user.click(screen.getByText("Remember me"));
    expect(change).toHaveBeenLastCalledWith(true);
    view.rerender(<Switch label="Remember me" checked onChange={change} />);
    expect(toggle).toBeChecked();
    toggle.focus();
    await user.keyboard(" ");
    expect(change).toHaveBeenLastCalledWith(false);
});

test("switches inherit a disabled fieldset and expose validation descriptions", async () => {
    const change = mock(() => {});
    render(
        <Fieldset disabled>
            <Switch
                label="Remember me"
                checked
                onChange={change}
                error="Unavailable for this account."
            />
        </Fieldset>
    );
    const toggle = screen.getByRole("switch", { name: "Remember me" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("aria-invalid", "true");
    expect(toggle).toHaveAccessibleDescription("Unavailable for this account.");
    await userEvent.setup().click(toggle);
    expect(change).not.toHaveBeenCalled();
});

test("hidden labels remain accessible and an explicit disabled switch cannot change", async () => {
    const change = mock(() => {});
    render(
        <Switch
            label="Compact setting"
            hideLabel
            checked={false}
            disabled
            onChange={change}
        />
    );
    const toggle = screen.getByRole("switch", { name: "Compact setting" });
    expect(toggle).toBeDisabled();
    expect(screen.getByText("Compact setting").parentElement).toHaveClass("sr-only");
    await userEvent.setup().click(toggle);
    expect(change).not.toHaveBeenCalled();
});
