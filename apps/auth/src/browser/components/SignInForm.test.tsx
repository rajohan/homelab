import { expect, spyOn, test } from "bun:test";

import { passwordPolicy } from "@homelab/contracts";
import { IdentityClient } from "@homelab/ui/identity/client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SignInForm } from "./SignInForm";

test.each([false, true])(
    "sign-in submits the explicit remembered-session choice %s",
    async (remember) => {
        const client = new IdentityClient();
        const request = spyOn(client, "request").mockResolvedValue({});
        const pending = Promise.withResolvers<void>();
        const view = render(
            <SignInForm client={client} onComplete={() => pending.promise} />
        );
        try {
            const user = userEvent.setup();
            const toggle = screen.getByRole("switch", { name: "Remember me" });
            expect(toggle).not.toBeChecked();
            await user.type(screen.getByLabelText("Username"), "fixture");
            await user.type(screen.getByLabelText("Password"), "fixture-password");
            if (remember) await user.click(toggle);
            await user.click(screen.getByRole("button", { name: "Sign in" }));
            expect(request).toHaveBeenCalledWith("/api/login", {
                username: "fixture",
                password: "fixture-password",
                remember,
            });
            expect(toggle).toBeDisabled();
        } finally {
            pending.resolve();
            view.unmount();
            request.mockRestore();
        }
    }
);

test("sign-in uses the shared twelve-character password policy", async () => {
    const client = new IdentityClient();
    const request = spyOn(client, "request").mockResolvedValue({});
    const view = render(
        <SignInForm client={client} onComplete={() => Promise.resolve()} />
    );
    try {
        const user = userEvent.setup();
        const password = screen.getByLabelText("Password");
        expect(password).toHaveAttribute(
            "minlength",
            String(passwordPolicy.minimumLength)
        );
        await user.type(screen.getByLabelText("Username"), "operator");
        await user.type(password, "short");
        await waitFor(() =>
            expect(password).toHaveAccessibleDescription(
                `Password must contain at least ${passwordPolicy.minimumLength} characters.`
            )
        );
        expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
        expect(request).not.toHaveBeenCalled();
    } finally {
        view.unmount();
        request.mockRestore();
    }
});
