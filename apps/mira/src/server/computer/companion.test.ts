import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { PassThrough } from "node:stream";

import { version } from "../../../../../package.json";
import {
    ComputerCompanion,
    ComputerConnectionError,
    ComputerRequestCancelledError,
    isComputerCancellation,
    computerOrigin,
    fetchComputer,
} from "./companion";
import { main } from "./companionCli";
import { readComputerTicket } from "./companionInput";
import { runComputerPresence } from "./companionPresence";
import { ComputerCredentialStore } from "./companionStore";
import { issueComputerCredential } from "./credentials";

const id = crypto.randomUUID();
const ticket = issueComputerCredential("pair", id).token;
const credential = issueComputerCredential("device", id).token;
const record = {
    id,
    credential,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    controlAllowed: false as const,
};
const signal = () => new AbortController().signal;
const metadata = {
    installationId: crypto.randomUUID(),
    platform: "win32",
    version: "0.10.0",
};
const connected = () => ({
    connectionId: crypto.randomUUID(),
    heartbeatSeconds: 15,
    leaseSeconds: 45,
    controlAllowed: false,
});

function vault() {
    const values = new Map<string, string>();
    const writes: Parameters<typeof Bun.secrets.set>[0][] = [];
    const store: typeof Bun.secrets = {
        get: ({ name }) => Promise.resolve(values.get(name) ?? null),
        set: (input) => {
            writes.push(input);
            values.set(input.name, input.value);
            return Promise.resolve();
        },
        delete: ({ name }) => Promise.resolve(values.delete(name)),
    };
    return { store, values, writes };
}

test("companion origin forbids insecure and ambiguous destinations before requests", async () => {
    expect(computerOrigin("https://EXAMPLE.test:443/")).toBe("https://example.test");
    for (const value of [
        "http://example.test",
        "https://u:p@example.test",
        "https://example.test/path",
        "https://example.test/?token=x",
        "https://example.test/#x",
        String.raw`https://example.test/\x`,
        " https://example.test",
        "not a URL",
    ])
        expect(() => computerOrigin(value)).toThrow();
    await rejects(main(["pair", "http://example.test"]), /HTTPS/);
    await rejects(main(["pair", "https://example.test", ticket]), /Never pass/);
    expect(typeof fetchComputer).toBe("function");
});

test("pairing sends one fixed request, binds the returned credential and refuses control-enabled receipts", async () => {
    let calls = 0;
    const client = new ComputerCompanion("https://private.example.test", (url, init) => {
        calls++;
        expect(url.href).toBe("https://private.example.test/api/mira/computers/enroll");
        expect(init.redirect).toBe("error");
        expect(init.credentials).toBe("omit");
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${ticket}`);
        expect(JSON.parse(typeof init.body === "string" ? init.body : "null")).toEqual(
            metadata
        );
        return Promise.resolve(Response.json(record));
    });
    expect(await client.enroll(ticket, metadata, signal())).toEqual(record);
    expect(calls).toBe(1);
    for (const body of [
        { ...record, id: crypto.randomUUID() },
        { ...record, credential: ticket },
        { ...record, controlAllowed: true },
        { ...record, expiresAt: "2000-01-01T00:00:00.000Z" },
    ]) {
        const invalid = new ComputerCompanion(client.origin, () =>
            Promise.resolve(Response.json(body))
        );
        await rejects(
            invalid.enroll(ticket, metadata, signal()),
            ComputerConnectionError
        );
    }
    await rejects(client.enroll(credential, metadata, signal()), ComputerConnectionError);
    expect(calls).toBe(1);
});

test("malformed, oversized, redirected and rejected responses never leak remote content or silently retry", async () => {
    for (const make of [
        () => new Response("private remote details", { status: 403 }),
        () => Response.redirect("https://another.example.test", 302),
        () => new Response("private HTML", { headers: { "content-type": "text/html" } }),
        () =>
            new Response("{private", { headers: { "content-type": "application/json" } }),
        () => Response.json({ padding: "x".repeat(4097) }),
        () => Response.json({ ...connected(), controlAllowed: true }),
    ]) {
        let calls = 0;
        const client = new ComputerCompanion("https://private.example.test", () => {
            calls++;
            return Promise.resolve(make());
        });
        await rejects(client.connect(credential, signal()), (error: unknown) => {
            expect(error).toBeInstanceOf(ComputerConnectionError);
            expect(String(error)).not.toContain("private remote");
            expect((error as ComputerConnectionError).retryable).toBe(false);
            return true;
        });
        expect(calls).toBe(1);
    }
    const outage = new ComputerCompanion("https://private.example.test", () =>
        Promise.resolve(new Response(null, { status: 503 }))
    );
    await rejects(
        outage.connect(credential, signal()),
        (error: unknown) => error instanceof ComputerConnectionError && error.retryable
    );
});

test("local cancellation stops a pending response body and never returns its late receipt", async () => {
    const stopped = new AbortController();
    let cancelled = false;
    const client = new ComputerCompanion("https://private.example.test", () =>
        Promise.resolve(
            new Response(
                new ReadableStream({
                    cancel() {
                        cancelled = true;
                    },
                }),
                { headers: { "content-type": "application/json" } }
            )
        )
    );
    const pending = client.connect(credential, stopped.signal);
    await Bun.sleep(1);
    stopped.abort();
    await rejects(pending, (error: unknown) => {
        expect(error).toBeInstanceOf(ComputerRequestCancelledError);
        expect(isComputerCancellation(error, stopped.signal)).toBe(true);
        expect(isComputerCancellation(error, AbortSignal.abort())).toBe(false);
        return true;
    });
    expect(
        isComputerCancellation(new Error("Unrelated teardown failure"), stopped.signal)
    ).toBe(false);
    expect(cancelled).toBe(true);
});

test("OS vault is origin-bound, local to this device and fails closed without a plaintext fallback", async () => {
    const f = vault();
    const store = new ComputerCredentialStore("https://a.example.test", f.store);
    expect(await store.read()).toBeNull();
    await store.save(record);
    expect(await store.read()).toEqual(record);
    expect(
        await new ComputerCredentialStore("https://b.example.test", f.store).read()
    ).toBeNull();
    expect(f.writes[0]).toMatchObject({
        persist: "local",
        service: "no.rajohan.homelab.mira.computer",
    });
    expect(f.writes[0]).not.toHaveProperty("allowUnrestrictedAccess");
    expect(f.writes[0]?.name).not.toContain(credential);
    await store.forget();
    expect(await store.read()).toBeNull();
    await store.save(record);
    f.values.set(f.writes[0]!.name, JSON.stringify({ ...record, credential: ticket }));
    await rejects(store.read(), /invalid/);
    const failing = new ComputerCredentialStore("https://a.example.test", {
        ...f.store,
        set: () => Promise.reject(new Error("sensitive vault detail")),
    });
    await rejects(failing.save(record), /Revoke this computer/);
    await rejects(
        new ComputerCredentialStore("https://a.example.test", {
            ...f.store,
            get: () => Promise.reject(new Error("sensitive")),
        }).read(),
        /store is unavailable/
    );
});

test("hidden pairing input restores raw mode and rejects oversized or interrupted tickets", async () => {
    const modes: boolean[] = [];
    const input = Object.assign(new PassThrough(), {
        isTTY: true,
        isRaw: false,
        setRawMode(mode: boolean) {
            modes.push(mode);
        },
    });
    const pending = readComputerTicket(input, signal());
    input.write(ticket + "x\b\r");
    expect(await pending).toBe(ticket);
    expect(modes).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
    for (const text of ["x".repeat(129), "\u0003", "invalid\n"]) {
        const stream = new PassThrough();
        const failed = readComputerTicket(stream, signal());
        stream.write(text);
        await rejects(failed, /stopped or invalid/);
        expect(stream.listenerCount("data")).toBe(0);
        stream.destroy();
    }
    input.destroy();
});

test("presence renews increasing sequences, reconnects outages and stops on generation rejection", async () => {
    const sequences: number[] = [];
    const states: string[] = [];
    const waits: number[] = [];
    let connections = 0;
    let beats = 0;
    const client = new ComputerCompanion("https://private.example.test", (url, init) => {
        if (url.pathname.endsWith("/connect")) {
            connections++;
            return Promise.resolve(Response.json(connected()));
        }
        const body = JSON.parse(typeof init.body === "string" ? init.body : "null") as {
            sequence: number;
        };
        sequences.push(body.sequence);
        beats++;
        if (beats === 2) return Promise.resolve(new Response(null, { status: 503 }));
        if (beats === 4) return Promise.resolve(new Response(null, { status: 403 }));
        return Promise.resolve(
            Response.json({ leaseSeconds: 45, controlAllowed: false })
        );
    });
    await rejects(
        runComputerPresence({
            companion: client,
            ...record,
            signal: signal(),
            status: (state) => states.push(state),
            wait: (ms) => {
                waits.push(ms);
                return Promise.resolve();
            },
        }),
        ComputerConnectionError
    );
    expect(connections).toBe(2);
    expect(sequences).toEqual([1, 2, 1, 2]);
    expect(states).toEqual(["connected", "reconnecting", "connected", "stopped"]);
    expect(waits).toContain(30_000);
    const stop = new AbortController();
    await runComputerPresence({
        companion: client,
        ...record,
        signal: stop.signal,
        status: () => {},
        wait: () => {
            stop.abort();
            return Promise.resolve();
        },
    });
    expect(beats).toBe(4);
    await rejects(
        runComputerPresence({
            companion: client,
            ...record,
            expiresAt: "invalid",
            signal: signal(),
            status: () => {},
        }),
        /expired/
    );
});

test("every authenticated connection reports the compiled client version", async () => {
    const bodies: unknown[] = [];
    const client = new ComputerCompanion("https://private.example.test", (url, init) => {
        expect(url.pathname).toBe("/api/mira/computers/connect");
        expect(new Headers(init.headers).get("authorization")).toBe(
            `Bearer ${credential}`
        );
        bodies.push(JSON.parse(typeof init.body === "string" ? init.body : "null"));
        return Promise.resolve(Response.json(connected()));
    });
    await client.connect(credential, signal());
    await client.connect(credential, signal());
    expect(bodies).toEqual([{ version }, { version }]);
});
