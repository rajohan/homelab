import { expect, spyOn, test } from "bun:test";

import { AccountSettings } from "@homelab/ui/identity";
import {
    IdentityClient,
    IdentityError,
    type AccountSnapshot,
} from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { IdentityBoundary } from "./IdentityBoundary";

test.each([
    ["Log out", "Revoke your current session?", "session/revoke"],
    ["Revoke all sessions", "Revoke all sessions?", "sessions/revoke-all"],
])("immediately closes private settings after %s", async (button, title, endpoint) => {
    const user = userEvent.setup();
    const client = new IdentityClient();
    let authenticated = true;
    const snapshot: AccountSnapshot = {
        user: {
            id: "fixture-user",
            username: "operator",
            email: "operator@example.test",
            emailVerified: true,
        },
        factors: [],
        recoveryCodesRemaining: 0,
        events: [],
        sessions: [
            {
                id: "fixture-session",
                userAgent: "Test browser",
                current: true,
                createdAt: "2026-01-01T00:00:00Z",
                lastSeenAt: "2026-01-01T00:00:00Z",
                expiresAt: "2026-01-02T00:00:00Z",
            },
        ],
    };
    const session = spyOn(IdentityClient.prototype, "session").mockImplementation(() =>
        Promise.resolve({ authenticated, mfaRequired: false, methods: [] })
    );
    const account = spyOn(client, "snapshot").mockImplementation(() =>
        authenticated
            ? Promise.resolve(snapshot)
            : Promise.reject(new IdentityError("UNAUTHORIZED", 401, "Signed out."))
    );
    const action = spyOn(client, "action").mockImplementation((path) => {
        if (path !== endpoint) throw new Error("Unexpected action");
        authenticated = false;
        return Promise.resolve({ ok: true });
    });
    const query = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityBoundary>
                <AccountSettings client={client} />
            </IdentityBoundary>
        </QueryClientProvider>
    );
    try {
        await user.click(await screen.findByRole("button", { name: button }));
        const dialog = await screen.findByRole("dialog", { name: title });
        await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
        expect(
            await screen.findByRole("heading", { name: "Welcome to Homelab" })
        ).toBeVisible();
        expect(
            screen.queryByRole("heading", { name: "Active sessions" })
        ).not.toBeInTheDocument();
        await waitFor(() =>
            expect(query.getQueryData(["identity", "account"])).toBeUndefined()
        );
        expect(action).toHaveBeenCalledTimes(1);
    } finally {
        view.unmount();
        query.clear();
        session.mockRestore();
        account.mockRestore();
        action.mockRestore();
    }
});

test("switching authenticated users clears old snapshots, dialogs and account caches", async () => {
    const client = new IdentityClient();
    let identity = "first";
    const snapshot = (): AccountSnapshot => ({
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
    });
    const session = spyOn(IdentityClient.prototype, "session").mockImplementation(() =>
        Promise.resolve({
            authenticated: true,
            userId: identity,
            username: identity,
            mfaRequired: false,
            methods: [],
        })
    );
    const account = spyOn(client, "snapshot").mockImplementation(() =>
        Promise.resolve(snapshot())
    );
    const query = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityBoundary>
                <AccountSettings client={client} />
            </IdentityBoundary>
        </QueryClientProvider>
    );
    try {
        expect(await screen.findByText("first@example.test")).toBeVisible();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Change email" }));
        expect(await screen.findByRole("dialog", { name: "Verify email" })).toBeVisible();
        query.setQueryData(["identity", "methods"], { old: true });
        identity = "second";
        await query.invalidateQueries({ queryKey: ["identity", "session"] });
        expect(await screen.findByText("second@example.test")).toBeVisible();
        expect(screen.queryByText("first@example.test")).not.toBeInTheDocument();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(query.getQueryData(["identity", "methods"])).toBeUndefined();
        expect(account).toHaveBeenCalledTimes(2);
    } finally {
        view.unmount();
        query.clear();
        session.mockRestore();
        account.mockRestore();
    }
});
