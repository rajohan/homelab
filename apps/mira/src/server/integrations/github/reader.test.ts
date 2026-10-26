import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { base, baseTree, configuration } from "../../testing/github";
import { githubReadProvider } from "../../testing/githubRead";
import { GitHubReader } from "./reader";
import { githubBlobHash } from "./repository";

const signal = new AbortController().signal;

test("GitHub context verifies identity and performs only fixed-origin GETs with explicit pagination", async () => {
    const f = githubReadProvider();
    expect(await f.reader.work({}, signal)).toMatchObject({
        commit: base,
        complete: true,
        nextPage: null,
        truncated: false,
        consistency: "best_effort",
        rows: [{ number: 123, author: "mira-2026" }],
    });
    expect(await f.reader.pullRequest({ number: 123 }, signal)).toMatchObject({
        body: "An existing proposal.",
        bodyTruncated: false,
        totalFiles: 2,
        nextPage: null,
        truncated: false,
        files: [
            { path: "src/app.ts", previousPath: null },
            { path: "old.txt", previousPath: "older.txt" },
        ],
    });
    expect(
        f.calls.every(
            (call) => call.init.method === "GET" && call.init.body === undefined
        )
    ).toBe(true);
    const work = f.calls.find((call) => call.url.pathname.endsWith("/pulls"))!;
    expect(work.url.searchParams.get("state")).toBe("open");
    expect(work.url.searchParams.get("base")).toBeNull();
    expect(work.url.searchParams.get("sort")).toBe("created");
});

test("GitHub open PR pages disclose limits and never imply a global atomic absence", async () => {
    const f = githubReadProvider(),
        original = f.pulls[0]!;
    f.pulls.splice(
        0,
        1,
        ...Array.from({ length: 1000 }, (_, index) => ({
            ...original,
            number: index + 1,
            html_url: `https://github.com/rajohan/homelab/pull/${index + 1}`,
        }))
    );
    expect(await f.reader.work({}, signal)).toMatchObject({
        complete: false,
        nextPage: 2,
        truncated: false,
    });
    expect(await f.reader.work({ page: 40 }, signal)).toMatchObject({
        complete: false,
        nextPage: null,
        truncated: true,
    });
    f.pulls.splice(26);
    expect(await f.reader.work({ page: 2 }, signal)).toMatchObject({
        complete: false,
        nextPage: null,
        truncated: false,
        rows: [{ number: 26 }],
    });
});

test("GitHub PR descriptions and changed-file pages expose truncation without forwarding patches", async () => {
    const f = githubReadProvider();
    f.pulls[0]!.body = "x".repeat(9000);
    f.pulls[0]!.changed_files = 301;
    f.files.splice(
        0,
        2,
        ...Array.from({ length: 301 }, (_, i) => ({
            filename: `src/${i}.ts`,
            status: "modified",
            patch: "ignored",
        }))
    );
    const first = await f.reader.pullRequest({ number: 123 }, signal);
    expect(first.body).toHaveLength(8000);
    expect(first.bodyTruncated).toBe(true);
    expect(first).toMatchObject({ nextPage: 2, truncated: true, totalFiles: 301 });
    expect(JSON.stringify(first.files)).not.toContain("ignored");
    expect(await f.reader.pullRequest({ number: 123, page: 10 }, signal)).toMatchObject({
        nextPage: null,
        truncated: true,
    });
    f.pulls[0]!.changed_files = 30;
    f.files.splice(30);
    expect(await f.reader.pullRequest({ number: 123 }, signal)).toMatchObject({
        nextPage: null,
        truncated: false,
    });
    f.files.splice(10);
    expect(await f.reader.pullRequest({ number: 123 }, signal)).toMatchObject({
        nextPage: null,
        truncated: true,
    });
});

test("GitHub source reads bind text, executable mode, empty files and guidance to exact main", async () => {
    const f = githubReadProvider();
    f.entries.push(
        {
            path: "AGENTS.md",
            mode: "100644",
            type: "blob",
            sha: "f".repeat(40),
            size: 12,
        },
        {
            path: "src/AGENTS.md",
            mode: "100644",
            type: "blob",
            sha: "e".repeat(40),
            size: 10,
        }
    );
    const file = await f.reader.sourceFile({ commit: base, path: "src/app.ts" }, signal);
    expect(file).toMatchObject({
        status: "ready",
        content: "before\n",
        mode: "100755",
        bytes: 7,
        guidance: ["AGENTS.md", "src/AGENTS.md"],
        gitSha: githubBlobHash(Buffer.from("before\n")),
        sha256: new Bun.CryptoHasher("sha256").update("before\n").digest("hex"),
    });
    expect(
        await f.reader.sourceFile({ commit: base, path: "empty.txt" }, signal)
    ).toMatchObject({ status: "ready", content: "", bytes: 0 });
    expect(
        await f.reader.sourceFile({ commit: base, path: "missing.ts" }, signal)
    ).toMatchObject({ status: "missing" });
    expect(
        await f.reader.sourceFile({ commit: base, path: "src" }, signal)
    ).toMatchObject({ status: "unsupported" });
    expect(
        await f.reader.sourceTree({ commit: base, prefix: "src" }, signal)
    ).toMatchObject({
        nextAfter: null,
        rows: [{ path: "src" }, { path: "src/AGENTS.md" }, { path: "src/app.ts" }],
    });
});

test("GitHub tree pagination is lexical and prefix boundaries do not match siblings", async () => {
    const f = githubReadProvider();
    f.entries.splice(
        0,
        f.entries.length,
        ...Array.from({ length: 102 }, (_, i) => ({
            path: `src/${String(i).padStart(3, "0")}.ts`,
            mode: "100644" as const,
            type: "blob" as const,
            sha: "f".repeat(40),
            size: 1,
        })),
        {
            path: "src-other/file",
            mode: "100644",
            type: "blob",
            sha: "f".repeat(40),
            size: 1,
        }
    );
    const first = await f.reader.sourceTree({ commit: base, prefix: "src" }, signal);
    expect(first.rows).toHaveLength(100);
    expect(first.nextAfter).toBe("src/099.ts");
    const second = await f.reader.sourceTree(
        { commit: base, prefix: "src", after: first.nextAfter! },
        signal
    );
    expect(second.rows.map((row) => row.path)).toEqual(["src/100.ts", "src/101.ts"]);
    expect(second.nextAfter).toBeNull();
});

for (const kind of ["symlink", "submodule", "large", "unknown-size"] as const)
    test(`GitHub source reports ${kind} without fetching a blob`, async () => {
        const f = githubReadProvider(),
            entry = f.entries[0]!;
        if (kind === "symlink") entry.mode = "120000";
        if (kind === "submodule") {
            entry.mode = "160000";
            entry.type = "commit";
        }
        if (kind === "large") entry.size = 65_537;
        if (kind === "unknown-size") delete entry.size;
        expect(
            await f.reader.sourceFile({ commit: base, path: entry.path }, signal)
        ).toMatchObject({
            status:
                kind === "large" || kind === "unknown-size" ? "too_large" : "unsupported",
        });
        expect(f.calls.some((call) => call.url.pathname.includes("/blobs/"))).toBe(false);
    });

test("GitHub exact blob decoding preserves BOM and Unicode and rejects binary/corrupt content", async () => {
    for (const mode of ["unicode", "binary", "corrupt", "encoding", "size"] as const) {
        const bytes =
            mode === "binary" ? Buffer.from([0xff]) : Buffer.from("\uFEFFæ\r\n");
        const sha = githubBlobHash(bytes);
        const f = githubReadProvider((url, _init, reply) =>
            url.pathname.includes("/blobs/")
                ? Response.json({
                      sha,
                      encoding: mode === "encoding" ? "utf8" : "base64",
                      size: mode === "size" ? 0 : bytes.length,
                      content:
                          mode === "corrupt"
                              ? Buffer.from("other").toString("base64")
                              : bytes.toString("base64"),
                  })
                : reply()
        );
        Object.assign(f.entries[0]!, { sha, size: bytes.length });
        const result = f.reader.sourceFile({ commit: base, path: "src/app.ts" }, signal);
        if (mode === "unicode")
            expect(await result).toMatchObject({
                status: "ready",
                content: "\uFEFFæ\r\n",
                bytes: bytes.length,
            });
        else await rejects(result);
    }
});

for (const fault of [
    "account",
    "repository",
    "url",
    "closed",
    "duplicate",
    "base-repo",
    "tree-truncated",
    "tree-sha",
    "commit-sha",
] as const)
    test(`GitHub context rejects ${fault} provider responses`, async () => {
        const f = githubReadProvider(async (url, _init, reply) => {
            const response = reply(),
                raw = await response.json();
            if (fault === "account" && url.pathname === "/user")
                (raw as { login: string }).login = "rajohan";
            if (fault === "repository" && url.pathname === "/repos/rajohan/homelab")
                (raw as { id: number }).id = 1;
            if (url.pathname.endsWith("/pulls")) {
                if (fault === "url")
                    (raw as { html_url: string }[])[0]!.html_url =
                        "https://other.invalid";
                if (fault === "closed") (raw as { state: string }[])[0]!.state = "closed";
                if (fault === "duplicate") (raw as unknown[]).push((raw as unknown[])[0]);
                if (fault === "base-repo")
                    (raw as { base: { repo: unknown } }[])[0]!.base.repo = null;
            }
            if (url.pathname.endsWith(baseTree)) {
                if (fault === "tree-truncated")
                    (raw as { truncated: boolean }).truncated = true;
                if (fault === "tree-sha") (raw as { sha: string }).sha = "a".repeat(40);
            }
            if (fault === "commit-sha" && url.pathname.includes("/git/commits/"))
                (raw as { sha: string }).sha = "f".repeat(40);
            return Response.json(raw);
        });
        await rejects(
            fault.startsWith("tree-") || fault === "commit-sha"
                ? f.reader.sourceTree({ commit: base }, signal)
                : f.reader.work({}, signal)
        );
    });

test("GitHub PR details reject changing heads, wrong numbers and inconsistent file pages", async () => {
    for (const fault of ["head", "number", "duplicate", "count"] as const) {
        let reads = 0;
        const f = githubReadProvider(async (url, _init, reply) => {
            const raw = await reply().json();
            if (url.pathname.endsWith("/pulls/123")) {
                reads++;
                if (fault === "head" && reads === 2)
                    (raw as { head: { sha: string } }).head.sha = "f".repeat(40);
                if (fault === "number") (raw as { number: number }).number = 124;
                if (fault === "count")
                    (raw as { changed_files: number }).changed_files = 1;
            }
            if (fault === "duplicate" && url.pathname.endsWith("/files"))
                (raw as unknown[]).push((raw as unknown[])[0]);
            return Response.json(raw);
        });
        await rejects(f.reader.pullRequest({ number: 123 }, signal));
    }
});

test("GitHub context tolerates deleted fork authors without following their locations", async () => {
    const f = githubReadProvider(async (url, _init, reply) => {
        const raw = await reply().json();
        if (url.pathname.endsWith("/pulls/123")) {
            (raw as { user: unknown }).user = null;
            (raw as { head: { repo: unknown } }).head.repo = null;
        }
        return Response.json(raw);
    });
    expect(await f.reader.pullRequest({ number: 123 }, signal)).toMatchObject({
        author: null,
        head: { repository: null },
    });
});

test("GitHub source and work reads fail when main moves during observation", async () => {
    for (const operation of ["work", "tree", "file"] as const) {
        let refs = 0;
        const f = githubReadProvider(async (url, _init, reply) => {
            const raw = await reply().json();
            if (url.pathname.endsWith("/heads/main") && ++refs === 2)
                (raw as { object: { sha: string } }).object.sha = "f".repeat(40);
            return Response.json(raw);
        });
        const operations = {
            work: () => f.reader.work({}, signal),
            tree: () => f.reader.sourceTree({ commit: base }, signal),
            file: () => f.reader.sourceFile({ commit: base, path: "src/app.ts" }, signal),
        };
        const result = operations[operation]();
        await rejects(result, /Main changed/);
    }
});

test("GitHub inputs reject selectors, traversal and invalid pagination before network access", async () => {
    const f = githubReadProvider();
    await rejects(f.reader.work({ page: 41 }, signal));
    await rejects(f.reader.work({ page: 0 }, signal));
    await rejects(f.reader.pullRequest({ number: 123, page: 11 }, signal));
    await rejects(f.reader.sourceFile({ commit: base, path: "../secret" }, signal));
    await rejects(f.reader.sourceFile({ commit: base, path: ".git/config" }, signal));
    await rejects(f.reader.sourceTree({ commit: "main" }, signal));
    await rejects(f.reader.sourceTree({ commit: base, prefix: "/etc" }, signal));
    await rejects(f.reader.work({ repository: "other" } as never, signal));
    await rejects(f.reader.work({}, AbortSignal.abort()));
    expect(f.calls).toHaveLength(0);
    const reader = new GitHubReader(
        configuration,
        Object.assign(
            () => Promise.resolve(new Response("rate limit", { status: 429 })),
            {
                preconnect: fetch.preconnect,
            }
        )
    );
    await rejects(reader.work({}, signal), /expected response/);
});
