import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

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
        expect(failure).toBeInstanceOf(TypeError);
        expect((failure as Error).message).toBe("Network unavailable");
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
