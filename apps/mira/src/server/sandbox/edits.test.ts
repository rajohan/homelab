import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSandboxEdits, readSandboxSources } from "./edits";
import { runSandboxProcess } from "./process";
import {
    daytonaEditContent,
    daytonaSourceContent,
    parseDaytonaArguments,
} from "./profile";

const commit = "a".repeat(40),
    id = "11111111-1111-4111-8111-111111111111";
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const signal = new AbortController().signal;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const plan = (files: unknown[]) => ({ version: 1, commit, files });
async function fixture() {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "mira-edits-")));
    const run = (args: string[]) =>
        runSandboxProcess(args, {
            cwd: root,
            env: {
                PATH: "/usr/bin:/bin",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
            },
            signal,
            timeoutMs: 5000,
        });
    return { root, run, close: () => rm(root, { recursive: true, force: true }) };
}

test("structured edits round-trip through real Git with exact Unicode, CRLF, empty files and modes", async () => {
    const f = await fixture();
    const old = {
        "source.ts": "\uFEFFconst name = 'æ';\r\n",
        "script.sh": "#!/bin/sh\necho old",
        "remove.txt": "gone\n",
        "empty.txt": "",
        "was-empty.txt": "",
    };
    const edits = [
        {
            path: "source.ts",
            beforeSha256: hash(old["source.ts"]),
            content: "\uFEFFconst name = '🍊';\r\n",
        },
        {
            path: "script.sh",
            beforeSha256: hash(old["script.sh"]),
            content: "#!/bin/sh\necho new",
        },
        { path: "remove.txt", beforeSha256: hash(old["remove.txt"]), content: null },
        { path: "empty.txt", beforeSha256: hash(""), content: null },
        { path: "was-empty.txt", beforeSha256: hash(""), content: "now filled\n" },
        { path: "nested/new.txt", beforeSha256: null, content: "new\n" },
        { path: "new-empty.txt", beforeSha256: null, content: "" },
    ];
    try {
        expect(await f.run(["git", "init", "--template="])).toMatchObject({
            exitCode: 0,
        });
        for (const [name, text] of Object.entries(old))
            await writeFile(path.join(f.root, name), text);
        await chmod(path.join(f.root, "script.sh"), 0o755);
        expect(await f.run(["git", "add", "."])).toMatchObject({ exitCode: 0 });
        const patch = await buildSandboxEdits(
            f.root,
            commit,
            encode(plan(edits)),
            signal
        );
        // Construction does not change originals, create output paths or touch the index.
        expect(await readFile(path.join(f.root, "source.ts"), "utf8")).toBe(
            old["source.ts"]
        );
        await rejects(lstat(path.join(f.root, "nested")));
        await writeFile(path.join(f.root, "selected.patch"), patch);
        expect(
            await f.run(["git", "apply", "--check", "--index", "selected.patch"])
        ).toMatchObject({ exitCode: 0 });
        expect(await f.run(["git", "apply", "--index", "selected.patch"])).toMatchObject({
            exitCode: 0,
        });
        for (const edit of edits) {
            if (edit.content === null) await rejects(lstat(path.join(f.root, edit.path)));
            else
                expect(await readFile(path.join(f.root, edit.path), "utf8")).toBe(
                    edit.content
                );
        }
        const mode = await lstat(path.join(f.root, "script.sh"));
        expect(mode.mode & 0o111).toBe(0o111);
        const replay = await f.run([
            "git",
            "apply",
            "--check",
            "--index",
            "selected.patch",
        ]);
        expect(replay.exitCode).not.toBe(0);
    } finally {
        await f.close();
    }
});

test("edit plans reject invalid paths, overlapping edits, stale originals and malformed text", async () => {
    const f = await fixture();
    const create = { path: "new.txt", beforeSha256: null, content: "new" };
    try {
        await writeFile(path.join(f.root, "old.txt"), "old");
        for (const name of [
            "../escape",
            "/absolute",
            "a//b",
            "a/../b",
            ".git/config",
            "a/.GIT/config",
            "C:/a",
            String.raw`a\b`,
            "a\nb",
            "a b",
            'a"b',
            "./a",
            "a/",
            "",
        ]) {
            await rejects(
                buildSandboxEdits(
                    f.root,
                    commit,
                    encode(plan([{ ...create, path: name }])),
                    signal
                )
            );
        }
        const cases = [
            plan([]),
            plan(Array.from({ length: 21 }, (_, i) => ({ ...create, path: `file${i}` }))),
            plan([create, create]),
            plan([create, { ...create, path: "new.txt/nested" }]),
            plan([{ ...create, path: "old.txt" }]),
            plan([{ ...create, path: "old.txt", beforeSha256: hash("changed") }]),
            plan([
                { ...create, path: "old.txt", beforeSha256: hash("old"), content: "old" },
            ]),
            plan([{ ...create, beforeSha256: hash("missing") }]),
            plan([{ ...create, content: null }]),
            plan([{ ...create, content: "\uD800" }]),
            plan([{ ...create, content: "\0" }]),
            plan([{ ...create, content: "\u0001" }]),
            plan([{ ...create, content: "ø".repeat(262_144) }]),
            plan([{ ...create, content: "x".repeat(262_145) }]),
            plan([{ ...create, beforeSha256: "bad" }]),
            plan([{ ...create, mode: "100755" }]),
            { ...plan([create]), commit: "b".repeat(40) },
            { ...plan([create]), version: 2 },
            { ...plan([create]), extra: true },
        ];
        for (const value of cases)
            await rejects(buildSandboxEdits(f.root, commit, encode(value), signal));
        for (const bytes of [
            new Uint8Array(),
            new Uint8Array(1_048_577),
            new Uint8Array([255]),
            new TextEncoder().encode("{"),
        ]) {
            await rejects(buildSandboxEdits(f.root, commit, bytes, signal));
        }
        const controller = new AbortController();
        controller.abort();
        await rejects(
            buildSandboxEdits(f.root, commit, encode(plan([create])), controller.signal)
        );
    } finally {
        await f.close();
    }
});

test("edit originals refuse links, FIFOs, oversized files and binary content without writing source", async () => {
    const f = await fixture();
    try {
        await mkdir(path.join(f.root, "real"));
        await writeFile(path.join(f.root, "real/file.txt"), "original");
        await symlink("real", path.join(f.root, "alias"));
        await symlink("real/file.txt", path.join(f.root, "linked.txt"));
        await symlink(f.root, path.join(f.root, "root-alias"));
        await writeFile(path.join(f.root, "large.txt"), "x".repeat(262_145));
        await writeFile(path.join(f.root, "binary.txt"), Buffer.from([0, 1]));
        await writeFile(path.join(f.root, "invalid.txt"), Buffer.from([255]));
        expect(await f.run(["mkfifo", "fifo.txt"])).toMatchObject({ exitCode: 0 });
        for (const name of [
            "alias/file.txt",
            "linked.txt",
            "large.txt",
            "binary.txt",
            "invalid.txt",
            "fifo.txt",
            "real",
            "real/file.txt/child",
        ]) {
            await rejects(
                buildSandboxEdits(
                    f.root,
                    commit,
                    encode(
                        plan([
                            {
                                path: name,
                                beforeSha256: hash("original"),
                                content: "new",
                            },
                        ])
                    ),
                    signal
                )
            );
        }
        await rejects(
            buildSandboxEdits(
                path.join(f.root, "root-alias"),
                commit,
                encode(plan([{ path: "new.txt", beforeSha256: null, content: "new" }])),
                signal
            )
        );
        const oversized = [];
        for (let i = 0; i < 3; i++) {
            await writeFile(path.join(f.root, `big${i}.txt`), "a".repeat(200_000));
            oversized.push({
                path: `big${i}.txt`,
                beforeSha256: hash("a".repeat(200_000)),
                content: "b".repeat(200_000),
            });
        }
        await rejects(
            buildSandboxEdits(f.root, commit, encode(plan(oversized)), signal),
            /Generated patch exceeds/
        );
        expect(await readFile(path.join(f.root, "real/file.txt"), "utf8")).toBe(
            "original"
        );
    } finally {
        await f.close();
    }
});

test("edit profile binds exact input and CLI modes while preserving existing patch arguments", () => {
    const sha256 = hash("edits"),
        edits = { id, sha256 };
    const content = daytonaEditContent({ id, commit, editsSha256: sha256 }, edits);
    expect(content.command).toBe(
        `bun --no-env-file /opt/homelab/daytona-check.js ${id} ${commit} --edits ${sha256}`
    );
    expect(content.inputs).toEqual([{ ...edits, name: "edits.json" }]);
    expect(() =>
        daytonaEditContent({ id, commit, editsSha256: hash("other") }, edits)
    ).toThrow();
    expect(parseDaytonaArguments([id, commit, "--edits", sha256])).toEqual({
        id,
        commit,
        editsSha256: sha256,
    });
    expect(parseDaytonaArguments([id, commit])).toEqual({
        id,
        commit,
        patchSha256: null,
    });
    expect(parseDaytonaArguments([id, commit, sha256])).toEqual({
        id,
        commit,
        patchSha256: sha256,
    });
    for (const args of [
        [],
        [id],
        [id, commit, "--edits"],
        [id, commit, "--other", sha256],
        [id, commit, "--edits", sha256, "extra"],
        [id, "main", "--edits", sha256],
    ]) {
        expect(() => parseDaytonaArguments(args)).toThrow();
    }
});

test("source inspection supplies exact fingerprints and missing-file evidence without following links", async () => {
    const f = await fixture();
    const text = "\uFEFFsource æ\r\n";
    try {
        await writeFile(path.join(f.root, "source.ts"), text);
        const result = JSON.parse(
            await readSandboxSources(
                f.root,
                commit,
                ["source.ts", "missing.ts", "source.ts"],
                signal
            )
        ) as { files: { path: string; content: string | null; sha256: string | null }[] };
        expect(result).toMatchObject({
            commit,
            trust: "untrusted_repository_source",
            files: [
                { path: "source.ts", content: text, sha256: hash(text), mode: "100644" },
                { path: "missing.ts", content: null, sha256: null, mode: null },
            ],
        });
        await symlink("source.ts", path.join(f.root, "alias.ts"));
        await rejects(readSandboxSources(f.root, commit, ["alias.ts"], signal));
        await rejects(readSandboxSources(f.root, commit, ["../outside"], signal));
        await rejects(readSandboxSources(f.root, "main", [], signal));
        const controller = new AbortController();
        controller.abort();
        await rejects(readSandboxSources(f.root, commit, [], controller.signal));
        for (let i = 0; i < 5; i++)
            await writeFile(path.join(f.root, `big${i}`), "x".repeat(250_000));
        await rejects(
            readSandboxSources(
                f.root,
                commit,
                ["big0", "big1", "big2", "big3", "big4"],
                signal
            ),
            /exceeds one MiB/
        );
        const selected = ["AGENTS.md", "a$(id).ts"];
        const draft = daytonaSourceContent({ id, commit, paths: selected });
        expect(draft.inputs).toEqual([]);
        expect(draft.outputs).toContain("source-files.json");
        expect(draft.command).toContain("--source 'AGENTS.md' 'a$(id).ts'");
        expect(parseDaytonaArguments([id, commit, "--source", ...selected])).toEqual({
            id,
            commit,
            paths: selected,
        });
        expect(parseDaytonaArguments([id, commit, "--source"])).toEqual({
            id,
            commit,
            paths: [],
        });
        for (const paths of [
            ["../escape"],
            ["a'b"],
            Array.from({ length: 21 }, () => "a"),
        ])
            expect(() =>
                parseDaytonaArguments([id, commit, "--source", ...paths])
            ).toThrow();
        const literal = await f.run([
            "sh",
            "-c",
            `printf '%s' ${draft.command.split("--source ")[1]!.split(" ").at(-1)}`,
        ]);
        expect(literal.stdout).toBe("a$(id).ts");
    } finally {
        await f.close();
    }
});
