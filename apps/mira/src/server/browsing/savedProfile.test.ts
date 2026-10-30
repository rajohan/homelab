import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
    chmod,
    lstat,
    link,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
    truncate,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { browserProfileMemoryBytes, browserProfileSnapshotBytes } from "./profile";
import { BrowserProfileCheckpoint } from "./profileCheckpoint";
import { prepareBrowserProfileShutdown } from "./profileShutdown";
import {
    captureBrowserProfile,
    restoreBrowserProfile,
    browserProfileSnapshot,
} from "./profileSnapshot";
import { BrowserProfileTransfer, browserProfileParts } from "./profileTransfer";
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

function snapshotOf(value: unknown) {
    return gzipSync(JSON.stringify(value)).toString("base64");
}

test("bounded profile snapshots round-trip regular files without runtime links or extraction aliases", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mira-profile-snapshot-"));
    try {
        const source = path.join(root, "source"),
            target = path.join(root, "target");
        await mkdir(path.join(source, "saved", "Default"), {
            recursive: true,
            mode: 0o700,
        });
        await mkdir(target, { mode: 0o700 });
        await writeFile(
            path.join(source, "saved", "Default", "Cookies"),
            "private synthetic cookie"
        );
        await symlink("/absent/socket", path.join(source, "saved", "SingletonSocket"));
        const snapshot = await captureBrowserProfile(source);
        expect(browserProfileSnapshot(snapshot)).toHaveLength(1);
        await restoreBrowserProfile(snapshot, target);
        expect(
            await readFile(path.join(target, "saved", "Default", "Cookies"), "utf8")
        ).toBe("private synthetic cookie");
        await assert.rejects(restoreBrowserProfile(snapshot, target));
        await symlink("/etc/passwd", path.join(source, "saved", "foreign"));
        await assert.rejects(captureBrowserProfile(source), /Unsupported/);
        await rm(path.join(source, "saved", "foreign"));
        await link(
            path.join(source, "saved", "Default", "Cookies"),
            path.join(source, "saved", "alias")
        );
        await assert.rejects(captureBrowserProfile(source), /Unsupported/);
        await rm(path.join(source, "saved", "alias"));
        const redirected = path.join(root, "redirected");
        await mkdir(redirected);
        await symlink(path.join(source, "saved"), path.join(redirected, "saved"));
        await assert.rejects(captureBrowserProfile(redirected));
        await truncate(
            path.join(source, "saved", "Default", "Cookies"),
            browserProfileMemoryBytes + 1
        );
        await assert.rejects(captureBrowserProfile(source), /Unsupported/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("profile snapshots refuse traversal, duplicates, compression expansion and byte excess", () => {
    for (const records of [
        [{ name: "../Cookies", data: "" }],
        [{ name: "/Cookies", data: "" }],
        [{ name: String.raw`Default\Cookies`, data: "" }],
        [{ name: "SingletonSocket/nested", data: "" }],
        [{ name: "Cookies", data: "!" }],
        [
            { name: "Cookies", data: "" },
            { name: "Cookies", data: "" },
        ],
        [
            { name: "Default", data: "" },
            { name: "Default/Cookies", data: "" },
        ],
        Array.from({ length: 5001 }, (_, index) => ({ name: String(index), data: "" })),
    ])
        expect(() => browserProfileSnapshot(snapshotOf(records))).toThrow();
    expect(() =>
        browserProfileSnapshot("a".repeat(browserProfileSnapshotBytes + 1))
    ).toThrow();
    const bomb = gzipSync(Buffer.alloc(96 * 1024 * 1024 + 1, 32)).toString("base64");
    expect(() => browserProfileSnapshot(bomb)).toThrow();
});

test("private profile transfer bounds aggregate chunks and saves only complete valid checkpoints", async () => {
    const snapshot = snapshotOf([
        { name: "Default/Cookies", data: Buffer.from("synthetic").toString("base64") },
    ]);
    const transfer = new BrowserProfileTransfer();
    expect(transfer.accept({ data: snapshot.slice(0, 4), last: false })).toBeUndefined();
    expect(transfer.accept({ data: snapshot.slice(4), last: true })).toBe(snapshot);
    expect(() => transfer.accept({ data: "", last: true })).toThrow();
    const oversized = new BrowserProfileTransfer();
    const chunk = { data: "a".repeat(32 * 1024), last: false };
    for (let index = 0; index < browserProfileSnapshotBytes / chunk.data.length; index++)
        oversized.accept(chunk);
    expect(() => oversized.accept(chunk)).toThrow();
    const writes: string[] = [];
    const persistence = {
        snapshot: null,
        save: (value: string) => {
            writes.push(value);
            return Promise.resolve();
        },
    };
    const complete = new BrowserProfileCheckpoint();
    complete.start();
    for (const part of browserProfileParts(snapshot)) complete.receive(part);
    await complete.persist(persistence);
    expect(writes).toEqual([snapshot]);
    const partial = new BrowserProfileCheckpoint();
    partial.start();
    partial.receive({ data: snapshot.slice(0, 4), last: false });
    partial.cancel();
    await partial.persist(persistence);
    const invalid = new BrowserProfileCheckpoint();
    invalid.start();
    expect(() => invalid.receive({ data: "aaaa", last: true })).toThrow();
    invalid.cancel();
    await invalid.persist(persistence);
    expect(writes).toEqual([snapshot]);
});
