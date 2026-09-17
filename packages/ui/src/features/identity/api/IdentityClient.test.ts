import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import * as webauthn from "@simplewebauthn/browser";

import { IdentityClient } from "../client";

const stale = () =>
    Response.json(
        { code: "STEP_UP_REQUIRED", message: "Verify again." },
        { status: 403 }
    );
const fetchSpy = spyOn(globalThis, "fetch");
afterAll(() => {
    fetchSpy.mockRestore();
});
afterEach(() => {
    fetchSpy.mockReset();
});
async function waitForPrompt(client: IdentityClient): Promise<void> {
    for (let index = 0; index < 20 && !client.verification.getSnapshot(); index += 1)
        await Promise.resolve();
    expect(client.verification.getSnapshot()).toBeGreaterThan(0);
}
describe("identity action replay", () => {
    test("retries only an explicitly rejected mutation with the same payload", async () => {
        const client = new IdentityClient();
        client.bindIdentity("user:session");
        fetchSpy
            .mockResolvedValueOnce(stale())
            .mockResolvedValueOnce(Response.json({ ok: true }));
        const action = client.action("email", { email: "new@example.test" });
        await waitForPrompt(client);
        client.verification.complete(client.verification.getSnapshot());
        expect(await action).toEqual({ ok: true });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(fetchSpy.mock.calls[1]?.[1]?.body);
    });
    test("does not retry a network error with an ambiguous outcome", async () => {
        const client = new IdentityClient();
        client.bindIdentity("user:session");
        fetchSpy.mockRejectedValueOnce(new TypeError("Network unavailable"));
        const failure = await client.action("email", {}).catch((error: unknown) => error);
        expect(failure).toMatchObject({ code: "NETWORK_ERROR", status: 0 });
        expect((failure as Error).message).toContain("Could not reach the server");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(client.verification.getSnapshot()).toBe(0);
    });
    test("does not replay after cancel, abort, or a changed session", async () => {
        for (const mode of ["cancel", "abort", "identity"]) {
            fetchSpy.mockReset().mockResolvedValueOnce(stale());
            const client = new IdentityClient();
            client.bindIdentity("user:session");
            const controller = new AbortController();
            const action = client.action("email", {}, controller.signal);
            const outcome = action.catch((error: unknown) => error);
            await waitForPrompt(client);
            if (mode === "cancel") client.verification.cancel();
            else if (mode === "abort") controller.abort();
            else client.bindIdentity("user:new-session");
            const failure = await outcome;
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toContain("cancelled");
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        }
    });
    test("a second step-up rejection is surfaced, never replayed indefinitely", async () => {
        const client = new IdentityClient();
        client.bindIdentity("user:session");
        fetchSpy.mockResolvedValueOnce(stale()).mockResolvedValueOnce(stale());
        const action = client.action("email", {});
        const outcome = action.catch((error: unknown) => error);
        await waitForPrompt(client);
        client.verification.complete(client.verification.getSnapshot());
        const failure = await outcome;
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("Verify again");
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
});

describe("verified domain operations", () => {
    const proofRequired = new Error("Fresh proof required");
    const requiresProof = (error: unknown) => error === proofRequired;

    test("replays once with the same live identity signal after verification", async () => {
        const client = new IdentityClient();
        client.bindIdentity("user:session");
        const signals: AbortSignal[] = [];
        const action = client.verifiedOperation((signal) => {
            signals.push(signal);
            return signals.length === 1
                ? Promise.reject(proofRequired)
                : Promise.resolve("completed");
        }, requiresProof);
        await waitForPrompt(client);
        client.verification.complete(client.verification.getSnapshot());
        expect(await action).toBe("completed");
        expect(signals).toHaveLength(2);
        expect(signals[1]).toBe(signals[0]);
        expect(signals[1]?.aborted).toBe(false);
    });

    test.each(["cancel", "abort", "identity"] as const)(
        "%s prevents replay of a verified domain operation",
        async (mode) => {
            const client = new IdentityClient();
            client.bindIdentity("user:session");
            let calls = 0;
            const outcome = client
                .verifiedOperation(() => {
                    calls += 1;
                    throw proofRequired;
                }, requiresProof)
                .catch((error: unknown) => error);
            await waitForPrompt(client);
            if (mode === "cancel") client.verification.cancel();
            else if (mode === "abort") client.cancelActions();
            else client.bindIdentity("user:replacement-session");
            expect(await outcome).toMatchObject({ code: "CANCELLED" });
            expect(calls).toBe(1);
        }
    );

    test("does not retry an ambiguous failure or prompt without a bound identity", async () => {
        for (const bound of [true, false]) {
            const client = new IdentityClient();
            if (bound) client.bindIdentity("user:session");
            const failure = bound ? new Error("Network failure") : proofRequired;
            let calls = 0;
            const outcome = await client
                .verifiedOperation(() => {
                    calls += 1;
                    throw failure;
                }, requiresProof)
                .catch((error: unknown) => error);
            expect(outcome).toBe(failure);
            expect(calls).toBe(1);
            expect(client.verification.getSnapshot()).toBe(0);
        }
    });

    test("surfaces a second proof rejection without prompting indefinitely", async () => {
        const client = new IdentityClient();
        client.bindIdentity("user:session");
        let calls = 0;
        const outcome = client
            .verifiedOperation(() => {
                calls += 1;
                throw proofRequired;
            }, requiresProof)
            .catch((error: unknown) => error);
        await waitForPrompt(client);
        client.verification.complete(client.verification.getSnapshot());
        expect(await outcome).toBe(proofRequired);
        expect(calls).toBe(2);
        expect(client.verification.getSnapshot()).toBe(0);
    });
});

test("timeouts and cancelled requests show actionable messages without replaying mutations", async () => {
    for (const [name, code, message] of [
        ["TimeoutError", "TIMEOUT", "The server took too long to respond"],
        ["AbortError", "CANCELLED", "The request was cancelled"],
    ] as const) {
        fetchSpy
            .mockReset()
            .mockRejectedValueOnce(new DOMException("signal timed out", name));
        const client = new IdentityClient();
        const failure = await client.action("email", {}).catch((error: unknown) => error);
        expect(failure).toMatchObject({ code, status: 0 });
        expect((failure as Error).message).toContain(message);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    }
});

test("a timeout while reading the response body is also translated", async () => {
    const response = new Response("{}");
    spyOn(response, "json").mockRejectedValueOnce(
        new DOMException("signal timed out", "TimeoutError")
    );
    fetchSpy.mockResolvedValueOnce(response);
    const failure = await new IdentityClient()
        .request("/api/session")
        .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "TIMEOUT", status: 0 });
});

describe("WebAuthn action cancellation", () => {
    const registration: Awaited<ReturnType<typeof webauthn.startRegistration>> = {
        id: "test-key",
        rawId: "test-key",
        response: { clientDataJSON: "test", attestationObject: "test" },
        type: "public-key",
        clientExtensionResults: {},
    };

    test.each(["cancel", "identity"] as const)(
        "%s during registration prevents the finish request",
        async (mode) => {
            const client = new IdentityClient();
            client.bindIdentity("user:session");
            const ceremony = Promise.withResolvers<typeof registration>();
            const started = Promise.withResolvers<void>();
            const register = spyOn(webauthn, "startRegistration").mockImplementation(
                () => {
                    started.resolve();
                    return ceremony.promise;
                }
            );
            fetchSpy
                .mockResolvedValueOnce(Response.json({ token: "test", options: {} }))
                .mockResolvedValueOnce(Response.json({ recoveryCodes: [] }));
            try {
                const outcome = client
                    .enrollSecurityKey("Test key")
                    .catch((error: unknown) => error);
                await started.promise;
                if (mode === "cancel") client.cancelActions();
                else client.bindIdentity("user:replacement-session");
                ceremony.resolve(registration);
                expect(await outcome).toMatchObject({ code: "CANCELLED" });
                expect(fetchSpy).toHaveBeenCalledTimes(1);
            } finally {
                register.mockRestore();
            }
        }
    );

    test("canceling a pending begin response prevents opening the authenticator", async () => {
        const client = new IdentityClient();
        client.bindIdentity("user:session");
        const begin = Promise.withResolvers<Response>();
        const register = spyOn(webauthn, "startRegistration").mockResolvedValue(
            registration
        );
        fetchSpy.mockReturnValueOnce(begin.promise);
        try {
            const outcome = client
                .enrollSecurityKey("Test key")
                .catch((error: unknown) => error);
            client.cancelActions();
            begin.resolve(Response.json({ token: "test", options: {} }));
            expect(await outcome).toMatchObject({ code: "CANCELLED" });
            expect(register).not.toHaveBeenCalled();
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
            register.mockRestore();
        }
    });

    test("canceling WebAuthn verification prevents submitting the late proof", async () => {
        const client = new IdentityClient();
        client.bindIdentity("user:session");
        const ceremony =
            Promise.withResolvers<
                Awaited<ReturnType<typeof webauthn.startAuthentication>>
            >();
        const started = Promise.withResolvers<void>();
        const authenticate = spyOn(webauthn, "startAuthentication").mockImplementation(
            () => {
                started.resolve();
                return ceremony.promise;
            }
        );
        fetchSpy
            .mockResolvedValueOnce(Response.json({ token: "test", options: {} }))
            .mockResolvedValueOnce(Response.json({ ok: true }));
        try {
            const outcome = client.securityKeyProof().catch((error: unknown) => error);
            await started.promise;
            client.cancelActions();
            ceremony.resolve({
                id: "test-key",
                rawId: "test-key",
                response: {
                    clientDataJSON: "test",
                    authenticatorData: "test",
                    signature: "test",
                },
                type: "public-key",
                clientExtensionResults: {},
            });
            expect(await outcome).toMatchObject({ code: "CANCELLED" });
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
            authenticate.mockRestore();
        }
    });

    test("an active registration still submits its result once", async () => {
        const register = spyOn(webauthn, "startRegistration").mockResolvedValue(
            registration
        );
        fetchSpy
            .mockResolvedValueOnce(Response.json({ token: "test", options: {} }))
            .mockResolvedValueOnce(Response.json({ recoveryCodes: ["test-recovery"] }));
        try {
            const client = new IdentityClient();
            client.bindIdentity("user:session");
            expect(await client.enrollSecurityKey("Test key")).toEqual(["test-recovery"]);
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(fetchSpy.mock.calls[1]?.[0]).toBe("/api/account/webauthn/finish");
        } finally {
            register.mockRestore();
        }
    });
});
