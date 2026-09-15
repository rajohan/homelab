import { expect, spyOn, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { IdentityClient } from "../../api/IdentityClient";
import { VerificationMethods } from "./VerificationMethods";

test("exhausted recovery codes disappear, including an already open recovery form", async () => {
    const client = new IdentityClient();
    let recoveryAvailable = true;
    const session = spyOn(client, "session").mockImplementation(() =>
        Promise.resolve({
            authenticated: true,
            mfaRequired: false,
            methods: ["totp"],
            recoveryAvailable,
        })
    );
    const query = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
        <QueryClientProvider client={query}>
            <VerificationMethods client={client} onVerified={() => {}} />
        </QueryClientProvider>
    );
    try {
        const user = userEvent.setup();
        await user.click(
            await screen.findByRole("button", { name: "Use recovery code" })
        );
        expect(screen.getByLabelText("Recovery code")).toBeVisible();
        recoveryAvailable = false;
        await query.invalidateQueries({ queryKey: ["identity", "methods"] });
        await waitFor(() =>
            expect(screen.queryByLabelText("Recovery code")).not.toBeInTheDocument()
        );
        expect(
            screen.queryByRole("button", { name: "Use recovery code" })
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Use authenticator app" })
        ).toBeVisible();
    } finally {
        view.unmount();
        query.clear();
        session.mockRestore();
    }
});
