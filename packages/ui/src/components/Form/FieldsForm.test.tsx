import { expect, mock, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FieldsForm } from "./FieldsForm";

test("validates edited fields immediately without showing untouched-field errors", async () => {
    const user = userEvent.setup();
    const submit = mock(() => Promise.resolve());
    render(
        <FieldsForm
            fields={[
                { name: "email", label: "Email address", type: "email" },
                { name: "password", label: "Password", type: "password", minimum: 12 },
            ]}
            submitLabel="Save"
            onSubmit={submit}
        />
    );
    const email = screen.getByLabelText("Email address");
    const password = screen.getByLabelText("Password");
    expect(email).not.toHaveAttribute("aria-invalid", "true");
    expect(password).not.toHaveAttribute("aria-invalid", "true");
    await user.type(email, "invalid");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription("Enter a valid email address.");
    expect(password).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.clear(email);
    await user.type(email, "you@example.test");
    expect(email).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByText("Enter a valid email address.")).not.toBeInTheDocument();
    await user.type(password, "short");
    expect(password).toHaveAccessibleDescription(
        "Password must contain at least 12 characters."
    );
    await user.clear(password);
    await user.type(password, "long-test-password");
    expect(password).not.toHaveAttribute("aria-invalid", "true");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(submit).toHaveBeenCalledTimes(1);
});

test("empty submit displays associated errors instead of native validation", async () => {
    const user = userEvent.setup();
    const submit = mock(() => Promise.resolve());
    const { container } = render(
        <FieldsForm
            fields={[
                { name: "username", label: "Username" },
                { name: "email", label: "Email", type: "email" },
            ]}
            submitLabel="Continue"
            onSubmit={submit}
        />
    );
    expect(container.querySelector("form")).toHaveAttribute("novalidate");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByLabelText("Username")).toHaveAccessibleDescription(
        "Username is required."
    );
    expect(screen.getByLabelText("Email")).toHaveAccessibleDescription(
        "Email is required."
    );
    expect(submit).not.toHaveBeenCalled();
});

test("request errors stay inside the form and clear when its values change", async () => {
    const user = userEvent.setup();
    render(
        <FieldsForm
            fields={[{ name: "username", label: "Username" }]}
            submitLabel="Continue"
            onSubmit={() => Promise.reject(new Error("The request failed."))}
        />
    );
    const input = screen.getByLabelText("Username");
    await user.type(input, "operator");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The request failed.");
    expect(screen.getByRole("alert").closest("form")).not.toBeNull();
    await user.type(input, "2");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("blur validates an empty field and editing clears its error immediately", async () => {
    const user = userEvent.setup();
    render(
        <FieldsForm
            fields={[{ name: "email", label: "Email", type: "email" }]}
            submitLabel="Continue"
            onSubmit={() => Promise.resolve()}
        />
    );
    const email = screen.getByLabelText("Email");
    await user.click(email);
    await user.tab();
    expect(email).toHaveAccessibleDescription("Email is required.");
    await user.type(email, "you@example.test");
    expect(email).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
});
