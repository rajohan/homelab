import { expect, mock, test } from "bun:test";

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PasswordForm } from "./PasswordForm";

test("uses the same password confirmation validation for reset and account forms", async () => {
    const submit = mock(() => Promise.resolve());
    render(<PasswordForm submitLabel="Save password" onSubmit={submit} />);
    const submitButton = screen.getByRole("button", { name: "Save password" });
    fireEvent.change(screen.getByLabelText("New password"), {
        target: { value: "replacement-password-123" },
    });
    fireEvent.change(screen.getByLabelText("Repeat new password"), {
        target: { value: "different-password-123" },
    });
    await waitFor(() =>
        expect(screen.getByLabelText("Repeat new password")).toHaveAccessibleDescription(
            "The new passwords do not match."
        )
    );
    expect(screen.getByLabelText("Repeat new password")).toHaveAttribute(
        "aria-invalid",
        "true"
    );
    expect(submitButton).toBeDisabled();
    expect(submit).not.toHaveBeenCalled();
    await act(async () => {
        fireEvent.change(screen.getByLabelText("Repeat new password"), {
            target: { value: "replacement-password-123" },
        });
        await Bun.sleep(250);
    });
    expect(submitButton).toBeEnabled();
    const form = submitButton.closest("form");
    if (!form) throw new Error("Password form was not rendered");
    fireEvent.submit(form);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
});

test("editing the original password revalidates the touched confirmation", async () => {
    const user = userEvent.setup();
    render(
        <PasswordForm submitLabel="Save password" onSubmit={() => Promise.resolve()} />
    );
    const password = screen.getByLabelText("New password");
    const confirmation = screen.getByLabelText("Repeat new password");
    fireEvent.change(password, { target: { value: "replacement-password-123" } });
    fireEvent.change(confirmation, { target: { value: "replacement-password-123" } });
    await user.type(password, "4");
    await waitFor(() =>
        expect(confirmation).toHaveAccessibleDescription(
            "The new passwords do not match."
        )
    );
    expect(screen.getByRole("button", { name: "Save password" })).toBeDisabled();
    await user.type(password, "{Backspace}");
    await waitFor(() => expect(confirmation).not.toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByRole("button", { name: "Save password" })).toBeEnabled();
});
