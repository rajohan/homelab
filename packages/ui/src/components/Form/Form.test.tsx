import { expect, mock, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button } from "../Button/Button";
import { Input } from "../Input/Input";
import { Fieldset } from "./Fieldset";
import { FieldsForm } from "./FieldsForm";
import { Form } from "./Form";
import { FormField } from "./FormField";

test("Form delegates submission and retains native validation by default", async () => {
    const submit = mock();
    const { container } = render(
        <Form onSubmit={submit}>
            <Button type="submit">Submit form</Button>
        </Form>
    );
    expect(container.querySelector("form")?.noValidate).toBe(false);
    await userEvent.setup().click(screen.getByRole("button", { name: "Submit form" }));
    expect(submit).toHaveBeenCalledTimes(1);
});

test("FormField associates descriptions and invalid state without owning the input", () => {
    render(
        <FormField
            label="Email"
            description="Use your personal address."
            error="Enter a valid email."
        >
            <Input type="email" />
        </FormField>
    );
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
        "Use your personal address. Enter a valid email."
    );
});

test("Fieldset propagates disabled and validation state through nested fields", () => {
    render(
        <Fieldset
            legend="Account recovery"
            description="Keep a recovery method."
            disabled
            error="A method is required."
        >
            <FormField label="Recovery email">
                <Input />
            </FormField>
        </Fieldset>
    );
    const group = screen.getByRole("group", { name: "Account recovery" });
    expect(group).toBeDisabled();
    const input = screen.getByLabelText("Recovery email");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("aria-invalid", "true");
});

test("FieldsForm passes descriptive placeholders without replacing visible labels", () => {
    render(
        <FieldsForm
            fields={[
                {
                    name: "username",
                    label: "Username",
                    placeholder: "Enter your username",
                },
            ]}
            submitLabel="Sign in"
            onSubmit={() => Promise.resolve()}
        />
    );
    expect(screen.getByPlaceholderText("Enter your username")).toBe(
        screen.getByRole("textbox", { name: "Username" })
    );
});
