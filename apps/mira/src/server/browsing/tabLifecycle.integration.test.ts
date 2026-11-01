import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { browserEndpoint } from "./endpoint";
import { openBrowserTabLifecycle } from "./tabLifecycle";

test.skipIf(process.platform !== "linux")(
    "browser endpoint requires owned profile markers and detects process replacement",
    async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "browser-endpoint-test-"));
        const profile = path.join(root, "profile"),
            proc = path.join(root, "proc");
        const marker = path.join(profile, "DevToolsActivePort");
        await mkdir(profile);
        await mkdir(path.join(proc, "123"), { recursive: true });
        const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "42"];
        const stat = path.join(proc, "123", "stat");
        const cmdline = path.join(proc, "123", "cmdline");
        await writeFile(stat, `123 (chromium) ${fields.join(" ")}`);
        await writeFile(cmdline, `chromium\0--user-data-dir=${profile}\0`);
        await writeFile(
            marker,
            "32123\n/devtools/browser/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\n"
        );
        try {
            const endpoint = await browserEndpoint(123, profile, proc);
            expect(endpoint.url).toStartWith("ws://127.0.0.1:32123/");
            expect(await endpoint.alive()).toBe(true);
            await rejects(browserEndpoint(123, path.join(root, "other"), proc));
            await rejects(browserEndpoint(-1, profile, proc));
            await writeFile(
                cmdline,
                `chromium\0--user-data-dir=${profile}\0--user-data-dir=${profile}\0`
            );
            await rejects(browserEndpoint(123, profile, proc));
            await writeFile(cmdline, `chromium\0--user-data-dir=${profile}\0`);
            await writeFile(
                marker,
                "0\n/devtools/browser/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
            );
            await rejects(browserEndpoint(123, profile, proc));
            await writeFile(marker, "x".repeat(257));
            await rejects(browserEndpoint(123, profile, proc));
            await rm(marker);
            await symlink(cmdline, marker);
            await rejects(browserEndpoint(123, profile, proc));
            fields[19] = "43";
            await writeFile(stat, `123 (chromium) ${fields.join(" ")}`);
            expect(await endpoint.alive()).toBe(false);
            await rm(stat);
            expect(await endpoint.alive()).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }
);

test("tab lifecycle sends only fixed commands and rejects malformed replies, cancellation and PID reuse", async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    let response: unknown,
        alive = true,
        hold = false,
        changeIdentity = false;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request, instance) =>
            instance.upgrade(request) ? undefined : new Response("No", { status: 400 }),
        websocket: {
            message(socket, data) {
                const call = JSON.parse(String(data)) as {
                    method: string;
                    params: Record<string, unknown>;
                };
                calls.push(call);
                if (changeIdentity) alive = false;
                if (!hold) socket.send(JSON.stringify({ id: 1, result: response }));
            },
        },
    });
    const owner = new AbortController();
    const endpoint = () =>
        Promise.resolve({
            url: `ws://127.0.0.1:${server.port}/`,
            alive: () => Promise.resolve(alive),
        });
    const port = await openBrowserTabLifecycle(123, owner.signal, endpoint);
    const signal = new AbortController().signal;
    const id = "A".repeat(32);
    try {
        response = {
            targetInfos: [
                { targetId: id, type: "page", url: "https://example.test/" },
                { targetId: "B".repeat(32), type: "browser_ui", url: "chrome://ui" },
            ],
        };
        expect(await port.pages(signal)).toHaveLength(1);
        response = { targetId: id };
        expect(await port.create(signal)).toBe(id);
        response = { success: true };
        await port.close(id, signal);
        expect(calls.map((call) => call.method)).toEqual([
            "Target.getTargets",
            "Target.createTarget",
            "Target.closeTarget",
        ]);
        expect(calls[1]!.params).toEqual({ url: "about:blank", background: true });
        await rejects(port.close("unowned-url", signal));
        expect(calls).toHaveLength(3);
        response = { success: false };
        await rejects(port.close(id, signal));
        response = "x".repeat(65 * 1024);
        await rejects(port.create(signal));
        response = { targetId: id };
        changeIdentity = true;
        await rejects(port.create(signal));
        const count = calls.length;
        await rejects(port.pages(signal));
        expect(calls.length).toBe(count);
        alive = true;
        changeIdentity = false;
        hold = true;
        const pending = port.pages(signal);
        await Bun.sleep(20);
        owner.abort();
        await rejects(pending);
        await rejects(port.pages(signal));
    } finally {
        owner.abort();
        await server.stop(true);
    }
});
