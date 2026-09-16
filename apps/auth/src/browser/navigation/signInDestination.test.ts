import { expect, spyOn, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";

import { signInDestination } from "./signInDestination";
import { submitOidcConsent } from "./submitOidcConsent";

test("handoffs only accept their expected OIDC or SSO destination", async () => {
    const client = new IdentityClient();
    const request = spyOn(client, "request");
    try {
        const auth = new URL("https://auth.example.test/sign-in?interaction=test");
        request.mockResolvedValue({ redirect: "/authorize/resume" });
        expect(await signInDestination(client, auth)).toBe(
            "https://auth.example.test/authorize/resume"
        );
        request.mockResolvedValue({ redirect: "https://attacker.example/authorize" });
        expect(
            await signInDestination(client, auth).then(
                () => null,
                (error: unknown) => error
            )
        ).toMatchObject({ message: "Invalid authorization return address." });
        const sso = new URL(
            "https://auth.example.test/sso?target=https%3A%2F%2Fapp.example.test%2Fprivate&nonce=fixture"
        );
        request.mockResolvedValue({
            redirect: "https://app.example.test/.homelab/sso/callback?code=fixture",
        });
        expect(await signInDestination(client, sso)).toBe(
            "https://app.example.test/.homelab/sso/callback?code=fixture"
        );
        for (const redirect of [
            "https://attacker.example/.homelab/sso/callback",
            "https://app.example.test/wrong",
        ]) {
            request.mockResolvedValue({ redirect });
            expect(
                await signInDestination(client, sso).then(
                    () => null,
                    (error: unknown) => error
                )
            ).toMatchObject({ message: "Invalid return address." });
        }
        expect(
            await signInDestination(client, new URL("https://auth.example.test/sign-in"))
        ).toBe("https://auth.example.test/account");
    } finally {
        request.mockRestore();
    }
});

test("consent rejects external continuations and unexpected repeat previews", async () => {
    const client = new IdentityClient();
    const request = spyOn(client, "request");
    const consent = {
        interactionId: "interaction",
        accountId: "account",
        clientId: "client",
        clientName: "Test client",
        username: "fixture",
        redirectOrigin: "https://client.example.test",
        scopes: ["openid"],
    };
    const address = new URL("https://auth.example.test/sign-in?interaction=interaction");
    try {
        for (const response of [
            { redirect: "https://attacker.example/authorize" },
            { consent },
        ]) {
            request.mockResolvedValue(response);
            expect(
                await submitOidcConsent(client, address, consent, "approve").then(
                    () => null,
                    (error: unknown) => error
                )
            ).toBeInstanceOf(Error);
        }
    } finally {
        request.mockRestore();
    }
});
