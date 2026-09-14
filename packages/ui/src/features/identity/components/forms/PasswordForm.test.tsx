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
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("match");
    expect(submit).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Repeat new password"));
    await user.type(
        screen.getByLabelText("Repeat new password"),
        "replacement-password-123"
    );
    await user.click(screen.getByRole("button", { name: "Save password" }));
    expect(submit).toHaveBeenCalledTimes(1);
});
