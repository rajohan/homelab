import { expect, test } from "bun:test";

import { validateFields } from "./validation";

test("field validation covers lengths, whitespace, email and custom rules", () => {
    const fields = [
        { name: "username", label: "Username", maximum: 5 },
        { name: "email", label: "Email", type: "email" as const },
        {
            name: "code",
            label: "Code",
            validate: (value: string) =>
                /^\d{6}$/.test(value) ? undefined : "Enter a 6-digit code.",
        },
    ];
    expect(
        validateFields(fields, { username: "      ", email: "bad", code: "abcdef" })
    ).toEqual({
        fields: {
            username: "Username is required.",
            email: "Enter a valid email address.",
            code: "Enter a 6-digit code.",
        },
    });
    expect(
        validateFields(fields, {
            username: "toolong",
            email: "a@example.test",
            code: "123456",
        })?.fields.username
    ).toContain("at most 5");
    expect(
        validateFields(fields, {
            username: "user",
            email: "a@example.test",
            code: "123456",
        })
    ).toBeUndefined();
});
