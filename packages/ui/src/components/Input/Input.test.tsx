import { expect, mock, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FormField } from "../Form/FormField";
import { Input } from "./Input";

test("standalone inputs work without a visible label and accept semantic props", async () => {
    const change = mock();
    render(
        <Input
            aria-label="Search services"
            onChange={change}
            placeholder="Search by service name"
            aria-invalid
            className="bg-primary-800"
        />
    );
    const input = screen.getByRole("textbox", { name: "Search services" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByPlaceholderText("Search by service name")).toBe(input);
    expect(input).toHaveClass("bg-primary-800");
    await userEvent.setup().type(input, "db");
    expect(input).toHaveValue("db");
    expect(change).toHaveBeenCalledTimes(2);
});

test("FormField composes the same input with an associated visible label", () => {
    render(
        <FormField label="Email address">
            <Input type="email" autoComplete="email" required />
        </FormField>
    );
    const input = screen.getByLabelText("Email address");
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("autocomplete", "email");
    expect(input).toBeRequired();
});

test("hover and focus states use the shared accent while disabled inputs stay inert", async () => {
    const user = userEvent.setup();
    const view = render(<Input aria-label="Project name" />);
    const input = screen.getByRole("textbox", { name: "Project name" });
    await user.hover(input);
    expect(input).toHaveAttribute("data-hover");
    expect(input).toHaveClass(
        "data-hover:not-data-disabled:not-data-invalid:border-accent-400"
    );
    await user.unhover(input);
    expect(input).not.toHaveAttribute("data-hover");
    view.rerender(<Input aria-label="Project name" disabled />);
    await user.hover(input);
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("data-disabled");
    expect(input).not.toHaveAttribute("data-hover");
});
