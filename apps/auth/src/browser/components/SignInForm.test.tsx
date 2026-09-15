import { expect, spyOn, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { render, screen } from "@testing-library/react";
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
            const checkbox = screen.getByRole("checkbox", { name: "Remember me" });
            expect(checkbox).not.toBeChecked();
            await user.type(screen.getByLabelText("Username"), "fixture");
            await user.type(screen.getByLabelText("Password"), "fixture-password");
            if (remember) await user.click(checkbox);
            await user.click(screen.getByRole("button", { name: "Sign in" }));
            expect(request).toHaveBeenCalledWith("/api/login", {
                username: "fixture",
                password: "fixture-password",
                remember,
            });
            expect(checkbox).toBeDisabled();
        } finally {
            pending.resolve();
            view.unmount();
            request.mockRestore();
        }
    }
);
