import { expect, mock, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PasswordForm } from "./PasswordForm";

test("uses the same password confirmation validation for reset and account forms", async () => {
    const user = userEvent.setup(),
        submit = mock(() => Promise.resolve());
    render(<PasswordForm submitLabel="Save password" onSubmit={submit} />);
    await user.type(screen.getByLabelText("New password"), "replacement-password-123");
    await user.type(
        screen.getByLabelText("Repeat new password"),
        "different-password-123"
    );
    expect(screen.getByLabelText("Repeat new password")).toHaveAccessibleDescription(
        "The new passwords do not match."
    );
    expect(screen.getByLabelText("Repeat new password")).toHaveAttribute(
        "aria-invalid",
        "true"
    );
    expect(screen.getByRole("button", { name: "Save password" })).toBeDisabled();
    expect(submit).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Repeat new password"));
    await user.type(
        screen.getByLabelText("Repeat new password"),
        "replacement-password-123"
    );
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(submit).toHaveBeenCalledTimes(1);
});

test("editing the original password revalidates the touched confirmation", async () => {
    const user = userEvent.setup();
    render(
        <PasswordForm submitLabel="Save password" onSubmit={() => Promise.resolve()} />
    );
    const password = screen.getByLabelText("New password");
    const confirmation = screen.getByLabelText("Repeat new password");
    await user.type(password, "replacement-password-123");
    await user.type(confirmation, "replacement-password-123");
    await user.type(password, "4");
    expect(confirmation).toHaveAccessibleDescription("The new passwords do not match.");
    expect(screen.getByRole("button", { name: "Save password" })).toBeDisabled();
    await user.type(password, "{Backspace}");
    expect(confirmation).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save password" })).toBeEnabled();
});
