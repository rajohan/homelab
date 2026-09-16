import { expect, spyOn, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";

import { VerifyEmailPage } from "./VerifyEmailPage";

test("email links submit once in Strict Mode and return to auth with a success notice", async () => {
    const client = new IdentityClient();
    const request = spyOn(client, "request").mockResolvedValue({});
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const view = render(
        <StrictMode>
            <VerifyEmailPage
                client={client}
                token="isolated-proof"
                address={new URL("https://auth.example.test/verify-email")}
            />
        </StrictMode>
    );
    try {
        await waitFor(() => expect(navigate).toHaveBeenCalledWith("/"));
        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith("/api/email/verify", {
            token: "isolated-proof",
        });
        expect(sessionStorage.getItem("homelab.email-verified")).toBe("true");
        expect(
            screen.queryByRole("button", { name: "Verify email" })
        ).not.toBeInTheDocument();
    } finally {
        view.unmount();
        request.mockRestore();
        navigate.mockRestore();
        sessionStorage.removeItem("homelab.email-verified");
    }
});

test("missing or rejected email proofs never navigate or claim success", async () => {
    const client = new IdentityClient();
    const request = spyOn(client, "request").mockRejectedValue(
        new Error("This link has expired.")
    );
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    const address = new URL("https://auth.example.test/verify-email");
    const view = render(
        <VerifyEmailPage client={client} token={null} address={address} />
    );
    try {
        expect(screen.getByRole("alert")).toHaveTextContent(
            "The verification failed or expired."
        );
        expect(request).not.toHaveBeenCalled();
        view.rerender(
            <VerifyEmailPage client={client} token="expired-proof" address={address} />
        );
        expect(await screen.findByRole("alert")).toHaveTextContent(
            "The verification failed or expired. You can request a new verification link in account settings."
        );
        expect(
            screen.queryByRole("link", { name: "Return to sign in" })
        ).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Account settings" })).toHaveClass(
            "w-full",
            "bg-accent-700"
        );
        expect(screen.getByRole("link", { name: "Account settings" })).toHaveAttribute(
            "href",
            "/account"
        );
        expect(navigate).not.toHaveBeenCalled();
        expect(sessionStorage.getItem("homelab.email-verified")).toBeNull();
    } finally {
        view.unmount();
        request.mockRestore();
        navigate.mockRestore();
    }
});
