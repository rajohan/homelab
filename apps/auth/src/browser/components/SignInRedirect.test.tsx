import { expect, spyOn, test } from "bun:test";

import { IdentityClient, IdentityError } from "@homelab/ui/identity/client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";

import { SignInRedirect } from "./SignInRedirect";

test("login and consent handoffs each complete automatically, once even with effect replay", async () => {
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

test("an expired interaction offers a new dashboard sign-in instead of repeating a dead request", async () => {
    const client = new IdentityClient();
    const request = spyOn(client, "request").mockRejectedValue(
        new IdentityError(
            "INTERACTION_EXPIRED",
            410,
            "This sign-in request has expired. Start a new sign-in to continue."
        )
    );
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
        expect(
            screen.queryByRole("button", { name: "Try again" })
        ).not.toBeInTheDocument();
        expect(navigate).toHaveBeenCalledWith("/account");
        expect(request).toHaveBeenCalledTimes(1);
    } finally {
        view.unmount();
        request.mockRestore();
        navigate.mockRestore();
    }
});
