import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
    mkdir,
    mkdtemp,
    realpath,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { RuntimeCleanupError } from "../runtime/rpcProcess";
import { createVisualChallenge } from "../testing/visualChallenge";
import { ComputerCompanion } from "./companion";
import type { ComputerConsentHost } from "./companionConsent";
import { runComputerPresence } from "./companionPresence";
import { computerConnectionWork } from "./companionWork";
import { issueComputerCredential } from "./credentials";
import { installedComputerHost, readComputerPackage } from "./installedComputer";
import type { ComputerWindowGrant } from "./policy";
import { assertLocalWindowsComputerDrive } from "./windowsDrive";

async function until(check: () => boolean) {
    for (let i = 0; i < 1000; i++) {
        if (check()) return;
        await Bun.sleep(1);
    }
    throw new Error("Computer fixture did not reach its transition.");
}
function fixture() {
    const stop = new AbortController();
    const local = new AbortController();
    const chosen = Promise.withResolvers<ComputerWindowGrant | null>();
    const computerId = crypto.randomUUID();
    const credential = issueComputerCredential("device", computerId).token;
    const request = {
        id: crypto.randomUUID(),
        computerId,
        runId: crypto.randomUUID(),
        mode: "control",
        state: "pending",
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        consentExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const events: string[] = [];
    const received: Record<string, unknown>[] = [];
    const behavior = {
        offline: false,
        claimOffline: false,
        finishOffline: false,
        failCleanup: false,
        holdCleanup: Promise.resolve(),
    };
    let claims = 0;
    const client = new ComputerCompanion("https://private.example.test", (url, init) => {
        const route = url.pathname.split("/").at(-1)!;
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        events.push(route);
        let result: unknown;
        if (route === "connect")
            result = {
                connectionId: crypto.randomUUID(),
                heartbeatSeconds: 15,
                leaseSeconds: 45,
                controlAllowed: false,
            };
        else if (route === "heartbeat") {
            if (behavior.offline)
                return Promise.resolve(new Response(null, { status: 503 }));
            result = { leaseSeconds: 45, controlAllowed: false };
        } else if (route === "pending") result = { request };
        else if (route === "accept") {
            const { consentExpiresAt: _deadline, ...summary } = request;
            result = { ...summary, state: "active" };
        } else if (route === "permit") result = { ...body, validForMs: 5000 };
        else if (route === "claim") {
            if (behavior.claimOffline)
                return Promise.resolve(new Response(null, { status: 503 }));
            claims++;
            if (claims > 2) return Promise.resolve(Response.json({ command: null }));
            result = {
                command: {
                    ...body,
                    commandId: crypto.randomUUID(),
                    validForMs: 5000,
                    operation:
                        claims === 1
                            ? { action: "observe" }
                            : {
                                  action: "type",
                                  text: "synthetic input",
                                  observationId: (
                                      received[0]!.result as { observationId: string }
                                  ).observationId,
                              },
                },
            };
        } else if (route === "finish") {
            received.push(body);
            if (behavior.finishOffline && received.length === 2)
                return Promise.resolve(new Response(null, { status: 503 }));
            result = { commandId: body.commandId, accepted: true };
        } else if (route === "stop") result = { stopped: true };
        else throw new Error("Unexpected fixture request.");
        return Promise.resolve(Response.json(result));
    });
    const host: ComputerConsentHost = {
        signal: local.signal,
        select: () => {
            events.push("prompt");
            return chosen.promise;
        },
        assertReady: () => Promise.resolve(),
        open: () => {
            events.push("open");
            return Promise.resolve({
                observe: () => {
                    events.push("capture");
                    return Promise.resolve({
                        snapshot: "synthetic",
                        width: 390,
                        height: 110,
                        content: {
                            content: [
                                {
                                    type: "image",
                                    mediaType: "image/png",
                                    data: createVisualChallenge().data,
                                },
                            ],
                        },
                    });
                },
                click: () => Promise.reject(new Error("Unexpected fixture click")),
                type: (text) => {
                    expect(text).toBe("synthetic input");
                    events.push("input");
                    return Promise.resolve({ effect: "confirmed" });
                },
                close: async () => {
                    events.push("driver-closing");
                    await behavior.holdCleanup;
                    if (behavior.failCleanup)
                        throw new Error("Unconfirmed fixture cleanup");
                    events.push("driver-closed");
                },
            });
        },
        close: () => {
            events.push("host-closed");
            return Promise.resolve();
        },
    };
    const run = () =>
        runComputerPresence({
            companion: client,
            credential,
            expiresAt: request.expiresAt,
            signal: stop.signal,
            status: (state) => events.push(state),
            connectionWork: computerConnectionWork({
                companion: client,
                credential,
                createHost: () => host,
            }),
            wait: async (ms, signal) => {
                if (ms === 30_000) {
                    events.push("retry");
                    stop.abort();
                    return;
                }
                await Bun.sleep(5);
                signal.throwIfAborted();
            },
        });
    const allow = () =>
        chosen.resolve({
            executable: path.resolve("synthetic-window"),
            pid: 123,
            windowId: "456",
            delivery: "foreground",
        });
    return { stop, local, chosen, request, events, received, behavior, run, allow };
}

test("installed connection work waits for local consent while heartbeats continue, then delivers serial commands and reaps on stop", async () => {
    const f = fixture();
    const running = f.run();
    try {
        await until(() => f.events.includes("prompt") && f.events.includes("heartbeat"));
        expect(f.events).not.toContain("accept");
        expect(f.events).not.toContain("open");
        expect(f.events).not.toContain("claim");
        f.allow();
        await until(() => f.received.length === 2);
        expect(f.events.indexOf("accept")).toBeLessThan(f.events.indexOf("open"));
        expect(
            f.events.filter((event) => ["capture", "input", "finish"].includes(event))
        ).toEqual(["capture", "finish", "input", "finish"]);
        expect(f.received[1]!.result).toEqual({ effect: "confirmed" });
    } finally {
        f.stop.abort();
        f.chosen.resolve(null);
        await running;
    }
    expect(f.events.indexOf("driver-closed")).toBeLessThan(f.events.indexOf("stop"));
    expect(f.events.at(-1)).toBe("stopped");
});

test("installed work cannot open a driver after declined local consent", async () => {
    const f = fixture();
    const running = f.run();
    try {
        await until(() => f.events.includes("prompt"));
        f.chosen.resolve(null);
        await until(() => f.events.includes("stop"));
        expect(f.events).not.toContain("accept");
        expect(f.events).not.toContain("open");
        expect(f.events).not.toContain("claim");
    } finally {
        f.stop.abort();
        f.chosen.resolve(null);
        await running;
    }
});

test("installed command teardown blocks reconnect until confirmed and failed cleanup remains terminal", async () => {
    for (const failCleanup of [false, true]) {
        const f = fixture();
        const cleanup = Promise.withResolvers<void>();
        f.behavior.holdCleanup = cleanup.promise;
        f.behavior.failCleanup = failCleanup;
        f.allow();
        const running = f.run();
        const outcome = running.then(
            () => null,
            (error: unknown) => error
        );
        try {
            await until(() => f.received.length === 2);
            f.behavior.offline = true;
            await until(() => f.events.includes("driver-closing"));
            expect(f.events).not.toContain("retry");
            expect(f.events.filter((event) => event === "connect")).toHaveLength(1);
            cleanup.resolve();
            if (failCleanup) {
                expect(await outcome).toBeInstanceOf(RuntimeCleanupError);
                expect(f.events).not.toContain("retry");
            } else {
                expect(await outcome).toBeNull();
                expect(f.events.indexOf("driver-closed")).toBeLessThan(
                    f.events.indexOf("retry")
                );
            }
        } finally {
            f.stop.abort();
            cleanup.resolve();
            await outcome;
        }
    }
});

test("temporary command polling reconnects only after cleanup while failed input acknowledgement stays terminal", async () => {
    for (const phase of ["poll", "finish"] as const) {
        const f = fixture();
        f.behavior.claimOffline = phase === "poll";
        f.behavior.finishOffline = phase === "finish";
        const cleanup = Promise.withResolvers<void>();
        f.behavior.holdCleanup = cleanup.promise;
        f.allow();
        const outcome = f.run().then(
            () => null,
            (error: unknown) => error
        );
        try {
            await until(() => f.events.includes("driver-closing"));
            expect(f.events).not.toContain("retry");
            cleanup.resolve();
            const result = await outcome;
            if (phase === "poll") {
                expect(result).toBeNull();
                expect(f.events.indexOf("retry")).toBeGreaterThan(
                    f.events.indexOf("driver-closed")
                );
                expect(f.events).not.toContain("input");
            } else {
                expect(result).toBeInstanceOf(RuntimeCleanupError);
                expect(f.events).not.toContain("retry");
                expect(f.events.filter((event) => event === "input")).toHaveLength(1);
            }
        } finally {
            f.stop.abort();
            cleanup.resolve();
            await outcome;
        }
    }
});

test("Windows package policy rejects mapped remote, unknown and UNC roots without accepting a path spelling as local evidence", async () => {
    for (const type of [0, 1, 4, 7, Number.NaN])
        await rejects(
            assertLocalWindowsComputerDrive(
                String.raw`Z:\package\mira-computer.exe`,
                () => Promise.resolve(type)
            )
        );
    for (const type of [2, 3, 5, 6])
        await assertLocalWindowsComputerDrive(
            String.raw`c:\package\MIRA-C~1.EXE`,
            (root) => {
                expect(root).toBe("c:" + path.win32.sep);
                return Promise.resolve(type);
            }
        );
    for (const file of [String.raw`\\host\share\mira-computer.exe`, "relative.exe"])
        await rejects(
            assertLocalWindowsComputerDrive(file, () =>
                Promise.reject(new Error("Must not probe UNC or relative paths"))
            ),
            /local Windows drive/
        );
    await rejects(
        assertLocalWindowsComputerDrive(String.raw`C:\mira-computer.exe`, () =>
            Promise.reject(new Error("Probe failed"))
        ),
        /Probe failed/
    );
});

test("the installed factory accepts only a complete canonical package and creates no native process before a request", async () => {
    const root = await realpath(
        await mkdtemp(path.join(tmpdir(), "mira-installed-test-"))
    );
    if (
        path.dirname(root) !== (await realpath(tmpdir())) ||
        !path.basename(root).startsWith("mira-installed-test-")
    )
        throw new Error("Unexpected fixture cleanup path.");
    const executable = path.join(root, "mira-computer.exe");
    const names = [
        "mira-computer.exe",
        "mira-computer-consent.exe",
        "mira-computer-worker-host.exe",
        "mira-computer-desktop.exe",
        "mira-computer-worker.exe",
    ];
    try {
        for (const name of names)
            await writeFile(path.join(root, name), "synthetic non-executable fixture");
        expect(await readComputerPackage(executable)).toBe(root);
        if (process.platform === "win32")
            expect(await readComputerPackage(executable.toUpperCase())).toBe(root);
        const create = await installedComputerHost(
            "https://private.example.test",
            executable
        );
        const first = create(),
            second = create();
        expect(first).not.toBe(second);
        await first.close();
        expect(first.signal.aborted).toBe(true);
        expect(second.signal.aborted).toBe(false);
        await second.close();
        await rejects(installedComputerHost("http://private.example.test", executable));
        await rejects(readComputerPackage("mira-computer.exe"));
        await rejects(readComputerPackage(path.join(root, "renamed.exe")));
        for (const name of names) {
            const file = path.join(root, name);
            await rename(file, file + ".missing");
            try {
                await rejects(readComputerPackage(executable));
            } finally {
                await rename(file + ".missing", file);
            }
        }
        const consent = path.join(root, "mira-computer-consent.exe");
        await rename(consent, consent + ".file");
        await mkdir(consent);
        await rejects(readComputerPackage(executable));
        await rm(consent, { recursive: true });
        await rename(consent + ".file", consent);
        if (process.platform !== "win32") {
            const alias = path.join(root, "alias");
            await symlink(root, alias);
            await rejects(readComputerPackage(path.join(alias, "mira-computer.exe")));
            await rename(consent, consent + ".file");
            await symlink(consent + ".file", consent);
            await rejects(readComputerPackage(executable));
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);
