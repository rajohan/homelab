import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    miraComputerUpdateUrl,
    type MiraComputerUpdate,
} from "@homelab/contracts/miraComputerUpdates";

import { withComputerUpdate } from "./updateDownload";

const bytes = Buffer.from("Synthetic installer bytes. Never executable.");
const candidate: MiraComputerUpdate = {
    repository: "demo/homelab",
    version: "0.11.0",
    revision: "a".repeat(40),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    validForMs: 60_000,
};
async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-update-test-"));
    return {
        options: {
            installedVersion: "0.10.9",
            temporaryDirectory: directory,
            signal: new AbortController().signal,
            getUpdate: () => Promise.resolve(candidate),
            request: () => Promise.resolve(new Response(bytes)),
        },
        directory,
        async close() {
            await rm(directory, { recursive: true, force: true });
        },
    };
}

test("verified update uses a derived official URL, drops all credentials on redirects, reauthorizes and removes staging", async () => {
    const f = await fixture();
    let lookups = 0;
    const urls: string[] = [];
    let file: string | undefined;
    try {
        const result = await withComputerUpdate(
            {
                ...f.options,
                getUpdate: () => {
                    lookups++;
                    return Promise.resolve(candidate);
                },
                request: (url, init) => {
                    urls.push(url.href);
                    expect(new Headers(init.headers).get("authorization")).toBeNull();
                    expect(new Headers(init.headers).get("cookie")).toBeNull();
                    expect(init.credentials).toBe("omit");
                    expect(init.redirect).toBe("manual");
                    return Promise.resolve(
                        urls.length === 1
                            ? new Response(null, {
                                  status: 302,
                                  headers: {
                                      location:
                                          "https://release-assets.githubusercontent.com/synthetic/installer",
                                  },
                              })
                            : new Response(bytes, {
                                  headers: { "content-length": String(bytes.length) },
                              })
                    );
                },
            },
            async (download, identity) => {
                file = download;
                expect(identity.version).toBe(candidate.version);
                expect(lookups).toBe(2);
                expect(await readFile(download)).toEqual(bytes);
                return "consumed";
            }
        );
        expect(result).toBe("consumed");
        expect(urls[0]).toBe(miraComputerUpdateUrl(candidate));
        await rejects(readFile(file!));
        expect(await readdir(f.directory)).toEqual([]);
    } finally {
        await f.close();
    }
});

test("unavailable, expired, equal, older and prerelease versions never fetch an executable", async () => {
    const f = await fixture();
    let fetches = 0;
    try {
        for (const update of [
            null,
            { ...candidate, validForMs: 0 },
            { ...candidate, version: "0.10.9" },
            { ...candidate, version: "0.9.99" },
            { ...candidate, version: "0.12.0-rc.1" },
            { ...candidate, repository: "demo/../other" },
        ])
            await rejects(
                withComputerUpdate(
                    {
                        ...f.options,
                        getUpdate: () => Promise.resolve(update),
                        request: () => {
                            fetches++;
                            return Promise.resolve(new Response(bytes));
                        },
                    },
                    () => Promise.reject(new Error("Must not dispatch"))
                )
            );
        await rejects(
            withComputerUpdate({ ...f.options, installedVersion: "0.12.0-rc.1" }, () =>
                Promise.resolve("unexpected")
            )
        );
        expect(fetches).toBe(0);
        expect(await readdir(f.directory)).toEqual([]);
    } finally {
        await f.close();
    }
});

test("changed metadata, byte lengths and hashes refuse consumption and clean partial files", async () => {
    const f = await fixture();
    let uses = 0;
    try {
        for (const response of [
            () => new Response(bytes.subarray(1)),
            () => new Response(Buffer.concat([bytes, Buffer.from("extra")])),
            () => new Response(Buffer.alloc(bytes.length)),
            () => new Response(bytes, { headers: { "content-length": "1" } }),
            () => new Response(null, { status: 503 }),
        ]) {
            await rejects(
                withComputerUpdate(
                    { ...f.options, request: () => Promise.resolve(response()) },
                    () => {
                        uses++;
                        return Promise.resolve();
                    }
                )
            );
            expect(await readdir(f.directory)).toEqual([]);
        }
        for (const change of [
            null,
            { ...candidate, revision: "b".repeat(40) },
            { ...candidate, repository: "other/repo" },
            { ...candidate, sha256: "c".repeat(64) },
        ]) {
            let calls = 0;
            await rejects(
                withComputerUpdate(
                    {
                        ...f.options,
                        getUpdate: () =>
                            Promise.resolve(++calls === 1 ? candidate : change),
                    },
                    () => {
                        uses++;
                        return Promise.resolve();
                    }
                )
            );
            expect(await readdir(f.directory)).toEqual([]);
        }
        expect(uses).toBe(0);
    } finally {
        await f.close();
    }
});

test("redirects never leave the fixed HTTPS asset origins or replay a download", async () => {
    const f = await fixture();
    try {
        for (const location of [
            "http://release-assets.githubusercontent.com/file",
            "https://github.com/other/file",
            "https://release-assets.githubusercontent.com.evil.test/file",
            "https://user:password@release-assets.githubusercontent.com/file",
            "https://objects.githubusercontent.com:8443/file",
            "file:///tmp/file",
        ]) {
            let calls = 0;
            await rejects(
                withComputerUpdate(
                    {
                        ...f.options,
                        request: () => {
                            calls++;
                            return Promise.resolve(
                                new Response(null, { status: 302, headers: { location } })
                            );
                        },
                    },
                    () => Promise.resolve("unexpected")
                )
            );
            expect(calls).toBe(1);
        }
        let calls = 0;
        await rejects(
            withComputerUpdate(
                {
                    ...f.options,
                    request: () => {
                        calls++;
                        return Promise.resolve(
                            new Response(null, {
                                status: 302,
                                headers: {
                                    location:
                                        "https://objects.githubusercontent.com/loop",
                                },
                            })
                        );
                    },
                },
                () => Promise.resolve("unexpected")
            )
        );
        expect(calls).toBe(4);
        expect(await readdir(f.directory)).toEqual([]);
    } finally {
        await f.close();
    }
});

test("cancellation and evidence deadlines cancel stalled streams and never dispatch late results", async () => {
    const f = await fixture();
    try {
        for (const deadline of [false, true]) {
            const stop = new AbortController();
            let cancelled = false;
            await rejects(
                withComputerUpdate(
                    {
                        ...f.options,
                        signal: stop.signal,
                        getUpdate: () =>
                            Promise.resolve({
                                ...candidate,
                                validForMs: deadline ? 50 : 60_000,
                            }),
                        request: () =>
                            Promise.resolve(
                                new Response(
                                    new ReadableStream({
                                        start(controller) {
                                            controller.enqueue(bytes.subarray(0, 1));
                                            if (!deadline)
                                                setTimeout(() => stop.abort(), 20);
                                        },
                                        cancel() {
                                            cancelled = true;
                                        },
                                    })
                                )
                            ),
                    },
                    () => Promise.resolve("unexpected")
                )
            );
            expect(cancelled).toBe(true);
            expect(await readdir(f.directory)).toEqual([]);
        }
    } finally {
        await f.close();
    }
});

test("post-download revocation, staged file changes and consumer failures leave no executable behind", async () => {
    const f = await fixture();
    try {
        for (const mode of ["revoke", "alter", "replace", "consumer"]) {
            let calls = 0,
                uses = 0;
            await rejects(
                withComputerUpdate(
                    {
                        ...f.options,
                        getUpdate: async () => {
                            if (++calls === 2) {
                                if (mode === "revoke") throw new Error("Pairing revoked");
                                if (mode === "replace") {
                                    const entries = await readdir(f.directory);
                                    const file = path.join(
                                        f.directory,
                                        entries[0]!,
                                        "setup.exe"
                                    );
                                    await rename(
                                        file,
                                        path.join(
                                            f.directory,
                                            entries[0]!,
                                            "original.exe"
                                        )
                                    );
                                    await writeFile(file, bytes);
                                }
                                if (mode === "alter") {
                                    const entries = await readdir(f.directory);
                                    await writeFile(
                                        path.join(f.directory, entries[0]!, "setup.exe"),
                                        Buffer.alloc(bytes.length)
                                    );
                                }
                            }
                            return candidate;
                        },
                    },
                    () => {
                        uses++;
                        return Promise.reject(new Error("Synthetic consumer failure"));
                    }
                )
            );
            expect(uses).toBe(mode === "consumer" ? 1 : 0);
            expect(await readdir(f.directory)).toEqual([]);
        }
    } finally {
        await f.close();
    }
});
