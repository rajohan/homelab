import { expect, spyOn, test } from "bun:test";

import {
    IdentityClient,
    IdentityError,
    type AccountSnapshot,
} from "@homelab/ui/identity/client";
import * as webauthn from "@simplewebauthn/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Settings } from "../pages/Settings";
import { IdentityBoundary } from "./IdentityBoundary";

test.each(["verify", "cancel"])(
    "a protected action outside Settings can %s through the global security prompt",
    async (outcome) => {
        const clients = new Set<IdentityClient>();
        const session = spyOn(IdentityClient.prototype, "session").mockImplementation(
            function (this: IdentityClient) {
                clients.add(this);
                return Promise.resolve({
                    authenticated: true,
                    userId: "operator",
                    sessionId: "first",
                    mfaRequired: false,
                    methods: [],
                });
            }
        );
        const request = spyOn(IdentityClient.prototype, "request").mockResolvedValue({
            ok: true,
        });
        const query = new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
        });
        const view = render(
            <QueryClientProvider client={query}>
                <IdentityBoundary>Applications content</IdentityBoundary>
            </QueryClientProvider>
        );
        let pending: Promise<unknown> | undefined;
        try {
            expect(await screen.findByText("Applications content")).toBeVisible();
            const shared = clients.values().next().value;
            if (!shared) throw new Error("Missing shared identity client");
            let calls = 0;
            await act(async () => {
                pending = shared
                    .verifiedOperation(
                        () => {
                            calls += 1;
                            return calls === 1
                                ? Promise.reject(new Error("STEP_UP_REQUIRED"))
                                : Promise.resolve("accepted");
                        },
                        (error) =>
                            error instanceof Error && error.message === "STEP_UP_REQUIRED"
                    )
                    .catch((error: unknown) => error);
                await Promise.resolve();
            });
            const dialog = await screen.findByRole("dialog", {
                name: "Confirm your identity",
            });
            expect(screen.getAllByRole("dialog")).toHaveLength(1);
            const user = userEvent.setup();
            if (outcome === "verify") {
                await user.type(
                    await within(dialog).findByLabelText("Current password"),
                    "Synthetic-password-123!"
                );
                await user.click(
                    within(dialog).getByRole("button", { name: "Verify password" })
                );
                expect(await pending).toBe("accepted");
                expect(calls).toBe(2);
                expect(request).toHaveBeenCalledWith("/api/account/proof/password", {
                    password: "Synthetic-password-123!",
                });
            } else {
                await user.click(
                    within(dialog).getByRole("button", { name: "Close dialog" })
                );
                expect(await pending).toBeInstanceOf(IdentityError);
                expect(calls).toBe(1);
            }
            await waitFor(() =>
                expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
            );
        } finally {
            view.unmount();
            await pending;
            query.clear();
            session.mockRestore();
            request.mockRestore();
        }
    }
);

test.each([
    ["Log out", "Log out this browser?", "session/revoke", "Log out", 0],
    ["Log out", "Log out this browser?", "session/revoke", "Log out", 1],
    [
        "Log out all",
        "Log out all sessions?",
        "sessions/revoke-all",
        "Log out everywhere",
        0,
    ],
])(
    "immediately closes private settings after %s",
    async (button, title, endpoint, confirmLabel, buttonIndex) => {
        const navigate = spyOn(globalThis.location, "replace").mockImplementation(
            () => {}
        );
        const user = userEvent.setup();
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
        const account = spyOn(IdentityClient.prototype, "snapshot").mockImplementation(
            () =>
                authenticated
                    ? Promise.resolve(snapshot)
                    : Promise.reject(
                          new IdentityError("UNAUTHORIZED", 401, "Signed out.")
                      )
        );
        const action = spyOn(IdentityClient.prototype, "action").mockImplementation(
            (path) => {
                if (path !== endpoint) throw new Error("Unexpected action");
                authenticated = false;
                return Promise.resolve({ ok: true });
            }
        );
        const activity = spyOn(IdentityClient.prototype, "activity").mockResolvedValue({
            events: [],
            nextCursor: null,
        });
        const query = new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
        });
        const view = render(
            <QueryClientProvider client={query}>
                <IdentityBoundary>
                    <Settings />
                </IdentityBoundary>
            </QueryClientProvider>
        );
        try {
            const buttons = await screen.findAllByRole("button", { name: button });
            const trigger = buttons[Number(buttonIndex)];
            if (!trigger) throw new Error("Logout action is missing.");
            await user.click(trigger);
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
        const account = spyOn(IdentityClient.prototype, "snapshot").mockImplementation(
            () => Promise.resolve(snapshot())
        );
        const activity = spyOn(IdentityClient.prototype, "activity").mockResolvedValue({
            events: [],
            nextCursor: null,
        });
        const query = new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
        });
        const view = render(
            <QueryClientProvider client={query}>
                <IdentityBoundary>
                    <Settings />
                </IdentityBoundary>
            </QueryClientProvider>
        );
        try {
            expect(await screen.findByText("first@example.test")).toBeVisible();
            const user = userEvent.setup();
            await user.click(screen.getByRole("button", { name: "Change email" }));
            expect(
                await screen.findByRole("dialog", { name: "Change email" })
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

test("declined authorization stays on a public retry screen without rendering private content", async () => {
    const original = globalThis.location.href;
    globalThis.history.replaceState(null, "", "/auth/declined?returnTo=%2Fsettings");
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
        expect(
            await screen.findByRole("heading", { name: "Access not approved" })
        ).toBeVisible();
        expect(screen.queryByText("Private content")).not.toBeInTheDocument();
        expect(navigate).not.toHaveBeenCalled();
        await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
        expect(navigate).toHaveBeenCalledWith("/login?returnTo=%2Fsettings");
    } finally {
        view.unmount();
        query.clear();
        session.mockRestore();
        navigate.mockRestore();
        globalThis.history.replaceState(null, "", original);
    }
});

test("Settings shares session cancellation with its boundary during WebAuthn enrollment", async () => {
    const clientSession = {
        authenticated: true,
        mfaRequired: false,
        methods: [],
        userId: "operator",
        sessionId: "first",
    };
    const session = spyOn(IdentityClient.prototype, "session").mockImplementation(() =>
        Promise.resolve({ ...clientSession })
    );
    const request = spyOn(IdentityClient.prototype, "request").mockImplementation(
        (path) => {
            if (path === "/api/account")
                return Promise.resolve({
                    user: {
                        id: "operator",
                        username: "operator",
                        email: clientSession.sessionId + "@example.test",
                        emailVerified: true,
                    },
                    factors: [],
                    recoveryCodesRemaining: 0,
                    sessions: [
                        {
                            id: clientSession.sessionId,
                            current: true,
                            userAgent: "Test browser",
                            createdAt: "2026-01-01T00:00:00Z",
                            lastSeenAt: "2026-01-01T00:00:00Z",
                            expiresAt: "2026-01-02T00:00:00Z",
                        },
                    ],
                });
            if (path === "/api/account/webauthn/begin")
                return Promise.resolve({ token: "test", options: {} });
            throw new Error("An unexpected request escaped the cancelled ceremony.");
        }
    );
    const activity = spyOn(IdentityClient.prototype, "activity").mockResolvedValue({
        events: [],
        nextCursor: null,
    });
    const ceremony =
        Promise.withResolvers<Awaited<ReturnType<typeof webauthn.startRegistration>>>();
    const register = spyOn(webauthn, "startRegistration").mockImplementation(
        () => ceremony.promise
    );
    const cancel = spyOn(
        webauthn.WebAuthnAbortService,
        "cancelCeremony"
    ).mockImplementation(() => {});
    const query = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityBoundary>
                <Settings />
            </IdentityBoundary>
        </QueryClientProvider>
    );
    try {
        const user = userEvent.setup();
        await user.click(await screen.findByRole("button", { name: "Add security key" }));
        await user.type(screen.getByLabelText("Key name"), "Fixture key");
        await user.click(screen.getByRole("button", { name: "Register security key" }));
        await waitFor(() => expect(register).toHaveBeenCalledTimes(1));
        clientSession.sessionId = "replacement";
        await query.invalidateQueries({ queryKey: ["identity", "session"] });
        expect(await screen.findByText("replacement@example.test")).toBeVisible();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(cancel).toHaveBeenCalledTimes(1);
        ceremony.resolve({
            id: "test-key",
            rawId: "test-key",
            response: { clientDataJSON: "test", attestationObject: "test" },
            type: "public-key",
            clientExtensionResults: {},
        });
        await ceremony.promise;
        await Promise.resolve();
        expect(
            request.mock.calls.some(([path]) => path === "/api/account/webauthn/finish")
        ).toBe(false);
    } finally {
        view.unmount();
        query.clear();
        session.mockRestore();
        request.mockRestore();
        activity.mockRestore();
        register.mockRestore();
        cancel.mockRestore();
    }
});
