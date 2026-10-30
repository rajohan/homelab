import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { requireBrowserProfileMount } from "./profileMount";
import { prepareBrowserProfileShutdown } from "./profileShutdown";
import { prepareSavedBrowserProfile } from "./savedProfile";

test("profile preparation removes only stale runtime entries and refuses links to stored data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mira-saved-profile-"));
    const profile = path.join(root, "saved");
    try {
        await prepareSavedBrowserProfile(root);
        await mkdir(profile, { mode: 0o700 });
        const retained = path.join(profile, "Cookies");
        await writeFile(retained, "synthetic persistent data");
        await symlink(retained, path.join(profile, "SingletonLock"));
        await symlink("/absent/socket", path.join(profile, "SingletonSocket"));
        await writeFile(path.join(profile, "DevToolsActivePort"), "old port");
        await prepareSavedBrowserProfile(root);
        expect(await readFile(retained, "utf8")).toBe("synthetic persistent data");
        await assert.rejects(lstat(path.join(profile, "SingletonLock")));
        await assert.rejects(lstat(path.join(profile, "DevToolsActivePort")));
        await symlink(retained, path.join(profile, "DevToolsActivePort"));
        await symlink(retained, path.join(profile, "SingletonCookie"));
        await assert.rejects(prepareSavedBrowserProfile(root), /runtime entry/);
        const retainedLink = await lstat(path.join(profile, "SingletonCookie"));
        expect(retainedLink.isSymbolicLink()).toBe(true);
        await chmod(profile, 0o755);
        await assert.rejects(prepareSavedBrowserProfile(root), /directory/);
        await chmod(profile, 0o700);
        await chmod(root, 0o755);
        await assert.rejects(prepareSavedBrowserProfile(root), /storage/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("profile mount inspection rejects foreign stopped containers and uncertain daemon results", async () => {
    const profile = { id: crypto.randomUUID() },
        current = "a".repeat(64);
    const call = (body: unknown, status = 200) =>
        requireBrowserProfileMount(
            (method, route) => {
                expect(method).toBe("GET");
                const url = new URL(route, "http://local.invalid");
                expect(url.searchParams.get("all")).toBe("1");
                expect(JSON.parse(url.searchParams.get("filters")!)).toEqual({
                    volume: [`mira-browser-profile-${profile.id}`],
                });
                return Promise.resolve({ status, body });
            },
            profile,
            current
        );
    await call([]);
    await call([{ Id: current }]);
    await assert.rejects(call([{ Id: "b".repeat(64) }]), /another container/);
    await assert.rejects(call([{ Id: "invalid" }]));
    await assert.rejects(call([], 503));
});

test("profile shutdown sends only Browser.close and waits for the owned process to exit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mira-profile-close-"));
    const profile = path.join(root, "saved"),
        proc = path.join(root, "proc");
    const pid = 71,
        processPath = path.join(proc, String(pid));
    await mkdir(profile, { mode: 0o700 });
    await mkdir(processPath, { recursive: true });
    const stat = (state: string, start = "123") =>
        `${pid} (fixture browser) ${[state, ...Array.from({ length: 18 }, () => "0"), start].join(" ")}`;
    await writeFile(path.join(processPath, "stat"), stat("S"));
    await writeFile(
        path.join(processPath, "cmdline"),
        `chromium\0--user-data-dir=${profile}\0`
    );
    let commands = 0;
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request, server) {
            if (server.upgrade(request)) return;
            return new Response(null, { status: 400 });
        },
        websocket: {
            async message(socket, message) {
                expect(JSON.parse(String(message))).toEqual({
                    id: 1,
                    method: "Browser.close",
                });
                commands++;
                socket.close();
                await Bun.sleep(40);
                await writeFile(path.join(processPath, "stat"), stat("Z"));
            },
        },
    });
    const marker = path.join(profile, "DevToolsActivePort");
    const port = `${server.port}\n/devtools/browser/${crypto.randomUUID()}\n`;
    try {
        for (const invalid of [
            "0\n/devtools/browser/invalid",
            "65536\n/devtools/browser/invalid",
            "https://remote.invalid/",
            "x".repeat(257),
        ]) {
            await writeFile(marker, invalid);
            await assert.rejects(prepareBrowserProfileShutdown(pid, root, proc));
        }
        await writeFile(marker, port);
        const close = await prepareBrowserProfileShutdown(pid, root, proc);
        await close();
        expect(commands).toBe(1);
        expect(await readFile(path.join(processPath, "stat"), "utf8")).toBe(stat("Z"));
        await close();
        expect(commands).toBe(1);
        await writeFile(path.join(processPath, "stat"), stat("S", "456"));
        await close();
        expect(commands).toBe(1);
        await writeFile(path.join(processPath, "cmdline"), "foreign\0");
        await assert.rejects(prepareBrowserProfileShutdown(pid, root, proc), /verified/);
    } finally {
        await server.stop(true);
        await rm(root, { recursive: true, force: true });
    }
});
