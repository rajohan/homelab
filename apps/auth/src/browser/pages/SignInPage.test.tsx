import { expect, spyOn, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";

import { SignInPage } from "./SignInPage";

test("a direct authenticated auth visit keeps the account menu and signs out in place", async () => {
    const client = new IdentityClient();
    let authenticated = true;
    const session = spyOn(client, "session").mockImplementation(() =>
        Promise.resolve({
            authenticated,
            mfaRequired: false,
            methods: [],
            username: "operator",
        })
    );
    const request = spyOn(client, "request").mockImplementation(() => {
        authenticated = false;
        return Promise.resolve({});
    });
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const query = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
        <QueryClientProvider client={query}>
            <SignInPage
                client={client}
                address={new URL("https://auth.example.test/sign-in")}
                token={null}
            />
        </QueryClientProvider>
    );
    try {
        expect(await screen.findByText("operator")).toBeVisible();
        expect(screen.getByRole("heading", { name: "Your account" })).toBeVisible();
        expect(
            screen.queryByRole("heading", { name: "Sign in" })
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("link", { name: "Forgot your password?" })
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: "Manage account security" })
        ).toHaveAttribute("href", "/account");
        expect(screen.getByRole("link", { name: "Continue" })).toHaveAttribute(
            "href",
            "/dashboard"
        );
        expect(navigate).not.toHaveBeenCalled();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Use another account" }));
        expect(await screen.findByLabelText("Username")).toBeVisible();
        expect(screen.getByRole("heading", { name: "Sign in" })).toBeVisible();
        expect(
            screen.getByRole("link", { name: "Forgot your password?" })
        ).toHaveAttribute("href", "/forgot-password");
        expect(
            screen.queryByRole("link", { name: "Manage account security" })
        ).not.toBeInTheDocument();
        expect(request).toHaveBeenCalledWith("/api/logout", {});
    } finally {
        view.unmount();
        query.clear();
        session.mockRestore();
        request.mockRestore();
        navigate.mockRestore();
    }
});

test.each(["totp", "recovery", "webauthn"] as const)(
    "completed %s verification automatically resumes OIDC without Continue",
    async (method) => {
        const client = new IdentityClient();
        let authenticated = false;
        const session = spyOn(client, "session").mockImplementation(() =>
            Promise.resolve({
                authenticated,
                mfaRequired: !authenticated,
                userId: "operator",
                sessionId: "fixture",
                username: "operator",
                methods: ["totp", "webauthn"],
                recoveryAvailable: true,
            })
        );
        const request = spyOn(client, "request").mockImplementation((path) => {
            if (path.startsWith("/api/account/proof/")) {
                authenticated = true;
                return Promise.resolve({});
            }
            if (path === "/sign-in/complete")
                return Promise.resolve({
                    redirect: "https://auth.example.test/authorize/fixture",
                });
            throw new Error("Unexpected test request");
        });
        const proof = spyOn(client, "securityKeyProof").mockImplementation(() => {
            authenticated = true;
            return Promise.resolve();
        });
        const navigate = spyOn(globalThis.location, "replace").mockImplementation(
            () => {}
        );
        const query = new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
        });
        const view = render(
            <StrictMode>
                <QueryClientProvider client={query}>
                    <SignInPage
                        client={client}
                        address={
                            new URL(
                                "https://auth.example.test/sign-in?interaction=fixture"
                            )
                        }
                        token={null}
                    />
                </QueryClientProvider>
            </StrictMode>
        );
        try {
            const user = userEvent.setup();
            const key = await screen.findByRole("button", { name: "Use security key" });
            expect(key.parentElement).toHaveClass("grid", "grid-cols-1", "gap-3");
            expect(
                screen.getByRole("heading", { name: "Verify your identity" })
            ).toBeVisible();
            expect(
                screen.getAllByText("Choose a verification method to finish signing in.")
            ).toHaveLength(1);
            expect(
                screen.queryByText("Use your account to continue to your homelab.")
            ).not.toBeInTheDocument();
            if (method === "webauthn") await user.click(key);
            else {
                await user.click(
                    screen.getByRole("button", {
                        name:
                            method === "totp"
                                ? "Use authenticator app"
                                : "Use recovery code",
                    })
                );
                expect(
                    screen.queryByText(
                        "Choose a verification method to finish signing in."
                    )
                ).not.toBeInTheDocument();
                expect(
                    screen.getByText(
                        method === "totp"
                            ? "Enter a 6-digit code from your authenticator app."
                            : "Enter one of your unused recovery codes."
                    )
                ).toBeVisible();
                expect(
                    screen
                        .getByRole("button", { name: "Use another method" })
                        .closest("form")
                ).toBe(screen.getByRole("button", { name: "Verify" }).closest("form"));
                await user.type(
                    screen.getByLabelText(
                        method === "totp" ? "Authenticator code" : "Recovery code"
                    ),
                    method === "totp" ? "123456" : "synthetic-recovery"
                );
                await user.click(screen.getByRole("button", { name: "Verify" }));
            }
            await waitFor(() =>
                expect(navigate).toHaveBeenCalledWith(
                    "https://auth.example.test/authorize/fixture"
                )
            );
            expect(
                request.mock.calls.filter(([path]) => path === "/sign-in/complete")
            ).toHaveLength(1);
            expect(screen.queryByText("Continue")).not.toBeInTheDocument();
        } finally {
            view.unmount();
            query.clear();
            session.mockRestore();
            request.mockRestore();
            proof.mockRestore();
            navigate.mockRestore();
        }
    }
);

test("stable pending-MFA polling preserves a security-key ceremony; signing out cancels it", async () => {
    const client = new IdentityClient();
    let authenticated = false;
    let mfaRequired = true;
    const session = spyOn(client, "session").mockImplementation(() =>
        Promise.resolve({
            authenticated,
            mfaRequired,
            userId: authenticated || mfaRequired ? "operator" : undefined,
            username: authenticated || mfaRequired ? "operator" : undefined,
            methods: ["webauthn"],
        })
    );
    const pending = Promise.withResolvers<void>();
    const proof = spyOn(client, "securityKeyProof").mockImplementation(
        () => pending.promise
    );
    const cancel = spyOn(client, "cancelActions");
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const query = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
        <QueryClientProvider client={query}>
            <SignInPage
                client={client}
                address={new URL("https://auth.example.test/sign-in")}
                token={null}
            />
        </QueryClientProvider>
    );
    try {
        await userEvent
            .setup()
            .click(await screen.findByRole("button", { name: "Use security key" }));
        expect(
            await screen.findByRole("button", { name: "Waiting for your security key…" })
        ).toBeDisabled();
        cancel.mockClear();
        await query.invalidateQueries({ queryKey: ["identity", "session"] });
        expect(cancel).not.toHaveBeenCalled();
        expect(
            screen.getByRole("button", { name: "Waiting for your security key…" })
        ).toBeDisabled();
        expect(proof).toHaveBeenCalledTimes(1);
        authenticated = true;
        mfaRequired = false;
        pending.resolve();
        await waitFor(() =>
            expect(navigate).toHaveBeenCalledWith("https://auth.example.test/account")
        );
        expect(cancel).not.toHaveBeenCalled();
        authenticated = false;
        await query.invalidateQueries({ queryKey: ["identity", "session"] });
        expect(cancel).toHaveBeenCalled();
        expect(query.getQueryData(["identity", "methods"])).toBeUndefined();
    } finally {
        pending.resolve();
        view.unmount();
        query.clear();
        session.mockRestore();
        proof.mockRestore();
        cancel.mockRestore();
        navigate.mockRestore();
    }
});

test.each(["choices", "totp", "recovery", "webauthn"] as const)(
    "a pending MFA account can be switched from %s without losing the caller",
    async (method) => {
        const client = new IdentityClient();
        let pendingMfa = true;
        const session = spyOn(client, "session").mockImplementation(() =>
            Promise.resolve({
                authenticated: false,
                mfaRequired: pendingMfa,
                userId: pendingMfa ? "wrong-account" : undefined,
                sessionId: pendingMfa ? "pending-session" : undefined,
                methods: ["totp", "webauthn"],
                recoveryAvailable: true,
            })
        );
        const request = spyOn(client, "request").mockImplementation((path) => {
            if (path !== "/api/logout") throw new Error("Unexpected test request");
            pendingMfa = false;
            return Promise.resolve({});
        });
        const ceremony = Promise.withResolvers<void>();
        const proof = spyOn(client, "securityKeyProof").mockImplementation(
            () => ceremony.promise
        );
        const cancel = spyOn(client, "cancelActions");
        const navigate = spyOn(globalThis.location, "replace").mockImplementation(
            () => {}
        );
        const query = new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 } },
        });
        const address = new URL(
            "https://auth.example.test/sign-in?interaction=original-caller"
        );
        const view = render(
            <QueryClientProvider client={query}>
                <SignInPage client={client} address={address} token={null} />
            </QueryClientProvider>
        );
        try {
            const key = await screen.findByRole("button", { name: "Use security key" });
            if (method !== "choices") {
                fireEvent.click(
                    method === "webauthn"
                        ? key
                        : screen.getByRole("button", {
                              name:
                                  method === "totp"
                                      ? "Use authenticator app"
                                      : "Use recovery code",
                          })
                );
            }
            const switchAccount = screen.getByRole("button", {
                name: "Use another account",
            });
            await act(() => {
                fireEvent.click(switchAccount);
                return Promise.resolve();
            });
            expect(await screen.findByLabelText("Username")).toBeVisible();
            expect(request).toHaveBeenCalledWith("/api/logout", {});
            expect(cancel).toHaveBeenCalled();
            await act(() => {
                ceremony.resolve();
                return Promise.resolve();
            });
            expect(navigate).not.toHaveBeenCalled();
            expect(address.searchParams.get("interaction")).toBe("original-caller");
            expect(
                screen.queryByRole("heading", { name: "Verify your identity" })
            ).not.toBeInTheDocument();
        } finally {
            ceremony.resolve();
            view.unmount();
            query.clear();
            session.mockRestore();
            request.mockRestore();
            proof.mockRestore();
            cancel.mockRestore();
            navigate.mockRestore();
        }
    }
);
