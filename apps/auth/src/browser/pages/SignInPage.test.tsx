import { expect, spyOn, test } from "bun:test";

import { IdentityClient, type AccountSnapshot } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SignInPage } from "./SignInPage";

test("auth account identity changes discard old account state and pending dialogs", async () => {
    const client = new IdentityClient();
    let identity = "first";
    const session = spyOn(client, "session").mockImplementation(() =>
        Promise.resolve({
            authenticated: true,
            userId: identity,
            username: identity,
            mfaRequired: false,
            methods: [],
        })
    );
    const snapshot = spyOn(client, "snapshot").mockImplementation(() =>
        Promise.resolve({
            user: {
                id: identity,
                username: identity,
                email: identity + "@example.test",
                emailVerified: true,
            },
            factors: [],
            recoveryCodesRemaining: 0,
            sessions: [],
            events: [],
        } satisfies AccountSnapshot)
    );
    const cancel = spyOn(client, "cancelActions");
    const query = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
        <QueryClientProvider client={query}>
            <SignInPage
                client={client}
                address={new URL("https://auth.example.test/account")}
                token={null}
            />
        </QueryClientProvider>
    );
    try {
        expect(await screen.findByText("first@example.test")).toBeVisible();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Change email" }));
        expect(await screen.findByRole("dialog", { name: "Verify email" })).toBeVisible();
        query.setQueryData(["identity", "methods"], { old: true });
        cancel.mockClear();
        identity = "second";
        await query.invalidateQueries({ queryKey: ["identity", "session"] });
        expect(await screen.findByText("second@example.test")).toBeVisible();
        expect(screen.queryByText("first@example.test")).not.toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(query.getQueryData(["identity", "methods"])).toBeUndefined();
        expect(cancel).toHaveBeenCalled();
        expect(snapshot).toHaveBeenCalledTimes(2);
        session.mockRejectedValueOnce(new Error("Synthetic service failure"));
        await query.invalidateQueries({ queryKey: ["identity", "session"] });
        expect(await screen.findByRole("button", { name: "Try again" })).toBeVisible();
        expect(screen.queryByText("second@example.test")).not.toBeInTheDocument();
    } finally {
        view.unmount();
        query.clear();
        session.mockRestore();
        snapshot.mockRestore();
        cancel.mockRestore();
    }
});
