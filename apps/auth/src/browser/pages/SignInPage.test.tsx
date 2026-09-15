import { expect, spyOn, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
