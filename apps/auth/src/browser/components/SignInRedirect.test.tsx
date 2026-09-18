import { expect, spyOn, test } from "bun:test";

import { IdentityClient, IdentityError } from "@homelab/ui/identity/client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";

import { SignInRedirect } from "./SignInRedirect";

test("verified login handoffs complete automatically, once even with effect replay", async () => {
    const client = new IdentityClient();
    const request = spyOn(client, "request").mockResolvedValue({
        redirect: "/authorize/resume",
    });
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const view = render(
        <StrictMode>
            <SignInRedirect
                onSignedOut={() => Promise.resolve()}
                key="login"
                client={client}
                address={new URL("https://auth.example.test/sign-in?interaction=login")}
            />
        </StrictMode>
    );
    try {
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        view.rerender(
            <StrictMode>
                <SignInRedirect
                    onSignedOut={() => Promise.resolve()}
                    key="consent"
                    client={client}
                    address={
                        new URL("https://auth.example.test/sign-in?interaction=consent")
                    }
                />
            </StrictMode>
        );
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));
        expect(request).toHaveBeenCalledTimes(2);
        expect(navigate).toHaveBeenLastCalledWith(
            "https://auth.example.test/authorize/resume"
        );
        expect(screen.queryByText("Continue")).not.toBeInTheDocument();
    } finally {
        view.unmount();
        request.mockRestore();
        navigate.mockRestore();
    }
});

test("a failed handoff stays on auth and retries only when requested", async () => {
    const client = new IdentityClient();
    const request = spyOn(client, "request")
        .mockRejectedValueOnce(new Error("Synthetic handoff failure"))
        .mockResolvedValueOnce({ redirect: "/authorize/resume" });
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const view = render(
        <SignInRedirect
            onSignedOut={() => Promise.resolve()}
            client={client}
            address={new URL("https://auth.example.test/sign-in?interaction=test")}
        />
    );
    try {
        await userEvent
            .setup()
            .click(await screen.findByRole("button", { name: "Try again" }));
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        expect(request).toHaveBeenCalledTimes(2);
    } finally {
        view.unmount();
        request.mockRestore();
        navigate.mockRestore();
    }
});

test("an unmounted handoff never redirects when its pending request finishes", async () => {
    const client = new IdentityClient();
    const pending = Promise.withResolvers<unknown>();
    const request = spyOn(client, "request").mockImplementation(() => pending.promise);
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const view = render(
        <SignInRedirect
            onSignedOut={() => Promise.resolve()}
            client={client}
            address={new URL("https://auth.example.test/sign-in?interaction=test")}
        />
    );
    try {
        view.unmount();
        pending.resolve({ redirect: "/authorize/resume" });
        await pending.promise;
        expect(navigate).not.toHaveBeenCalled();
    } finally {
        request.mockRestore();
        navigate.mockRestore();
    }
});

test("an account that cannot complete a handoff can switch accounts", async () => {
    const client = new IdentityClient();
    const request = spyOn(client, "request").mockImplementation((path) =>
        path === "/api/logout"
            ? Promise.resolve({})
            : Promise.reject(new Error("Client access denied"))
    );
    let signedOut = false;
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const view = render(
        <SignInRedirect
            client={client}
            address={new URL("https://auth.example.test/sign-in?interaction=test")}
            onSignedOut={() => {
                signedOut = true;
                return Promise.resolve();
            }}
        />
    );
    try {
        expect(await screen.findByRole("button", { name: "Try again" })).toBeVisible();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Use another account" }));
        await waitFor(() => expect(signedOut).toBe(true));
        expect(request).toHaveBeenCalledWith("/api/logout", {});
        expect(navigate).not.toHaveBeenCalled();
    } finally {
        view.unmount();
        request.mockRestore();
        navigate.mockRestore();
    }
});

test("an expired interaction automatically restarts from its registered app without retrying the dead request", async () => {
    sessionStorage.removeItem("homelab.sign-in-restart");
    const client = new IdentityClient();
    const request = spyOn(client, "request")
        .mockRejectedValueOnce(
            new IdentityError(
                "INTERACTION_EXPIRED",
                410,
                "This sign-in request has expired. Start a new sign-in to continue."
            )
        )
        .mockResolvedValueOnce({ redirect: "https://dashboard.example.test/" });
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const view = render(
        <SignInRedirect
            client={client}
            address={
                new URL(
                    "https://auth.example.test/sign-in?interaction=expired&client=dashboard"
                )
            }
            onSignedOut={() => Promise.resolve()}
        />
    );
    try {
        await waitFor(() =>
            expect(navigate).toHaveBeenCalledWith("https://dashboard.example.test/")
        );
        expect(
            screen.queryByRole("button", { name: "Try again" })
        ).not.toBeInTheDocument();
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenLastCalledWith("/api/sign-in/restart", {
            clientId: "dashboard",
        });
    } finally {
        view.unmount();
        request.mockRestore();
        navigate.mockRestore();
        sessionStorage.removeItem("homelab.sign-in-restart");
    }
});

test("repeated expired handoffs stop rather than looping and still allow an explicit restart", async () => {
    sessionStorage.setItem("homelab.sign-in-restart", String(Date.now()));
    const client = new IdentityClient();
    const request = spyOn(client, "request")
        .mockRejectedValueOnce(new IdentityError("INTERACTION_EXPIRED", 410, "Expired"))
        .mockResolvedValueOnce({ redirect: "https://auth.example.test/account" });
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const view = render(
        <SignInRedirect
            client={client}
            address={new URL("https://auth.example.test/sign-in?interaction=expired")}
            onSignedOut={() => Promise.resolve()}
        />
    );
    try {
        await userEvent
            .setup()
            .click(await screen.findByRole("button", { name: "Start a new sign-in" }));
        await waitFor(() =>
            expect(navigate).toHaveBeenCalledWith("https://auth.example.test/account")
        );
        expect(request).toHaveBeenCalledTimes(2);
    } finally {
        view.unmount();
        request.mockRestore();
        navigate.mockRestore();
        sessionStorage.removeItem("homelab.sign-in-restart");
    }
});

const consent = {
    interactionId: "request-id",
    accountId: "account-id",
    clientId: "dashboard",
    clientName: "Homelab Dashboard",
    username: "fixture-user",
    redirectOrigin: "https://dashboard.example.test",
    scopes: ["openid", "profile", "email", "account"],
};

test.each(["approve", "deny"] as const)(
    "OIDC %s requires an explicit decision and submits only the displayed request identity",
    async (decision) => {
        const client = new IdentityClient();
        const request = spyOn(client, "request")
            .mockResolvedValueOnce({ consent })
            .mockResolvedValueOnce({ redirect: "/authorize/resume" });
        const navigate = spyOn(globalThis.location, "replace").mockImplementation(
            () => {}
        );
        const view = render(
            <StrictMode>
                <SignInRedirect
                    client={client}
                    address={
                        new URL(
                            "https://auth.example.test/sign-in?interaction=request-id"
                        )
                    }
                    onSignedOut={() => Promise.resolve()}
                />
            </StrictMode>
        );
        try {
            const action = await screen.findByRole("button", {
                name: decision === "approve" ? "Approve" : "Deny",
            });
            expect(
                screen.getByRole("heading", { name: "Approve access?" })
            ).toBeVisible();
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
            expect(
                screen.getByText("Homelab Dashboard wants to use your Homelab account.")
            ).toBeVisible();
            expect(
                screen.getByText("Read your email address and verification status")
            ).toBeVisible();
            expect(
                screen.getByText("Manage your account security and sessions")
            ).toBeVisible();
            expect(screen.getByText(consent.redirectOrigin)).toBeVisible();
            expect(request).toHaveBeenCalledTimes(1);
            expect(navigate).not.toHaveBeenCalled();
            await userEvent.setup().click(action);
            await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
            expect(request).toHaveBeenCalledTimes(2);
            expect(request).toHaveBeenLastCalledWith("/sign-in/complete", {
                interactionId: consent.interactionId,
                accountId: consent.accountId,
                decision,
            });
            expect(navigate).toHaveBeenCalledWith(
                "https://auth.example.test/authorize/resume"
            );
        } finally {
            view.unmount();
            request.mockRestore();
            navigate.mockRestore();
        }
    }
);

test("a failed consent decision stays on its page and retries only on another explicit click", async () => {
    const client = new IdentityClient();
    const pending = Promise.withResolvers<unknown>();
    const request = spyOn(client, "request")
        .mockResolvedValueOnce({
            consent: { ...consent, clientName: "Another application" },
        })
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValueOnce({ redirect: "/authorize/resume" });
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const view = render(
        <SignInRedirect
            client={client}
            address={new URL("https://auth.example.test/sign-in?interaction=request-id")}
            onSignedOut={() => Promise.resolve()}
        />
    );
    try {
        const user = userEvent.setup();
        const approve = await screen.findByRole("button", { name: "Approve" });
        await user.click(approve);
        expect(approve).toBeDisabled();
        expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
        expect(
            screen.queryByRole("button", { name: "Close dialog" })
        ).not.toBeInTheDocument();
        pending.reject(new Error("Synthetic decision failure"));
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled()
        );
        expect(screen.getByRole("heading", { name: "Approve access?" })).toBeVisible();
        expect(request).toHaveBeenCalledTimes(2);
        expect(navigate).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Approve" }));
        await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
        expect(request).toHaveBeenCalledTimes(3);
    } finally {
        view.unmount();
        request.mockRestore();
        navigate.mockRestore();
    }
});

test.each(["INTERACTION_EXPIRED", "CONSENT_CONFLICT"])(
    "a %s decision offers a fresh sign-in instead of an unusable consent form",
    async (code) => {
        const client = new IdentityClient();
        const request = spyOn(client, "request")
            .mockResolvedValueOnce({ consent })
            .mockRejectedValueOnce(new IdentityError(code, 409, "Start a new sign-in."))
            .mockResolvedValueOnce({ redirect: "https://auth.example.test/account" });
        const navigate = spyOn(globalThis.location, "replace").mockImplementation(
            () => {}
        );
        const view = render(
            <SignInRedirect
                client={client}
                address={
                    new URL("https://auth.example.test/sign-in?interaction=request-id")
                }
                onSignedOut={() => Promise.resolve()}
            />
        );
        try {
            const user = userEvent.setup();
            await user.click(await screen.findByRole("button", { name: "Approve" }));
            const restart = await screen.findByRole("button", {
                name: "Start a new sign-in",
            });
            expect(
                screen.queryByRole("button", { name: "Approve" })
            ).not.toBeInTheDocument();
            await user.click(restart);
            await waitFor(() =>
                expect(navigate).toHaveBeenCalledWith("https://auth.example.test/account")
            );
            expect(request).toHaveBeenCalledTimes(3);
            expect(request).toHaveBeenLastCalledWith("/api/sign-in/restart", {
                clientId: null,
            });
        } finally {
            view.unmount();
            request.mockRestore();
            navigate.mockRestore();
        }
    }
);
