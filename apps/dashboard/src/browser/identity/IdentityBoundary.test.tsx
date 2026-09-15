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
    ["Log out", "Log out this browser?", "session/revoke", "Log out"],
    ["Log out all", "Log out all sessions?", "sessions/revoke-all", "Log out everywhere"],
])(
    "immediately closes private settings after %s",
    async (button, title, endpoint, confirmLabel) => {
        const navigate = spyOn(globalThis.location, "replace").mockImplementation(
            () => {}
        );
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
        const session = spyOn(IdentityClient.prototype, "session").mockImplementation(
            () => Promise.resolve({ authenticated, mfaRequired: false, methods: [] })
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
        const activity = spyOn(client, "activity").mockResolvedValue({
            events: [],
            nextCursor: null,
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
            await user.click(within(dialog).getByRole("button", { name: confirmLabel }));
            await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
            expect(
                screen.queryByRole("link", { name: "Sign in" })
            ).not.toBeInTheDocument();
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
            activity.mockRestore();
            action.mockRestore();
            navigate.mockRestore();
        }
    }
);

test.each(["different-user", "same-user"])(
    "dashboard %s session changes clear snapshots, dialogs and account caches",
    async (kind) => {
        const client = new IdentityClient();
        let identity = "first";
        let sessionId = "first";
        const snapshot = (): AccountSnapshot => ({
            user: {
                id: identity,
                username: identity,
                email: sessionId + "@example.test",
                emailVerified: true,
            },
            factors: [],
            recoveryCodesRemaining: 0,
            sessions: [],
        });
        const session = spyOn(IdentityClient.prototype, "session").mockImplementation(
            () =>
                Promise.resolve({
                    authenticated: true,
                    userId: identity,
                    sessionId,
                    username: identity,
                    mfaRequired: false,
                    methods: [],
                })
        );
        const account = spyOn(client, "snapshot").mockImplementation(() =>
            Promise.resolve(snapshot())
        );
        const activity = spyOn(client, "activity").mockResolvedValue({
            events: [],
            nextCursor: null,
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
            expect(await screen.findByText("first@example.test")).toBeVisible();
            const user = userEvent.setup();
            await user.click(screen.getByRole("button", { name: "Change email" }));
            expect(
                await screen.findByRole("dialog", { name: "Verify email" })
            ).toBeVisible();
            query.setQueryData(["identity", "methods"], { old: true });
            if (kind === "different-user") identity = "second";
            sessionId = "second";
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
            activity.mockRestore();
        }
    }
);

test("anonymous dashboard visits go straight to login with their complete destination", async () => {
    const original = globalThis.location.href;
    globalThis.history.replaceState(null, "", "/infrastructure?view=hosts#storage");
    const session = spyOn(IdentityClient.prototype, "session").mockResolvedValue({
        authenticated: false,
        mfaRequired: false,
        methods: [],
    });
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const query = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityBoundary>Private content</IdentityBoundary>
        </QueryClientProvider>
    );
    try {
        await waitFor(() =>
            expect(navigate).toHaveBeenCalledWith(
                "/login?returnTo=%2Finfrastructure%3Fview%3Dhosts%23storage"
            )
        );
        expect(screen.queryByText("Private content")).not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
    } finally {
        view.unmount();
        query.clear();
        session.mockRestore();
        navigate.mockRestore();
        globalThis.history.replaceState(null, "", original);
    }
});

test("an unavailable identity service offers retry instead of an automatic redirect loop", async () => {
    const session = spyOn(IdentityClient.prototype, "session").mockRejectedValue(
        new Error("Synthetic outage")
    );
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const query = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityBoundary>Private content</IdentityBoundary>
        </QueryClientProvider>
    );
    try {
        expect(await screen.findByRole("button", { name: "Try again" })).toBeVisible();
        expect(navigate).not.toHaveBeenCalled();
        expect(screen.queryByText("Private content")).not.toBeInTheDocument();
    } finally {
        view.unmount();
        query.clear();
        session.mockRestore();
        navigate.mockRestore();
    }
});
