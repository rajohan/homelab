import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSandboxDirectory, readSandboxPatch, writeSandboxArtifact } from "./files";
import { runDaytonaChecks } from "./harness";
import { runSandboxProcess } from "./process";
import { daytonaCheckContent, daytonaCheckProfile } from "./profile";
import { executeDaytonaChecks, sandboxEnvironment } from "./workflow";

const signal = new AbortController().signal;
const id = "11111111-1111-4111-8111-111111111111";
const commit = "a".repeat(40);
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
async function temporary() {
    const made = await mkdtemp(path.join(tmpdir(), "mira-harness-test-"));
    return realpath(made);
}

test("fixed check proposals bind exact commit and selected patch without shell arguments", () => {
    const content = daytonaCheckContent({ id, commit, patchSha256: null });
    expect(content.command).toBe(
        `bun --no-env-file /opt/homelab/daytona-check.js ${id} ${commit}`
    );
    expect(content.outputs).toEqual(daytonaCheckProfile.outputs);
    expect(content.inputs).toEqual([]);
    const patch = { id, sha256: hash("patch") };
    expect(
        daytonaCheckContent({ id, commit, patchSha256: patch.sha256 }, patch).inputs
    ).toEqual([{ ...patch, name: "changes.txt" }]);
    for (const invalid of [
        "main",
        commit + ";id",
        "https://example.com/repo",
        "../source",
    ]) {
        expect(() =>
            daytonaCheckContent({ id, commit: invalid, patchSha256: null })
        ).toThrow();
    }
    expect(() =>
        daytonaCheckContent({ id: "../outside", commit, patchSha256: null })
    ).toThrow();
    expect(() =>
        daytonaCheckContent({ id, commit, patchSha256: hash("other") }, patch)
    ).toThrow();
    expect(() =>
        daytonaCheckContent({ id, commit, patchSha256: patch.sha256 })
    ).toThrow();
    expect(() => daytonaCheckContent({ id, commit, patchSha256: null }, patch)).toThrow();
});

test("check harness refuses to run on the host and constructs a clean child environment", async () => {
    expect(sandboxEnvironment("/tmp/work")).toEqual({
        PATH: "/usr/local/bin:/usr/lib/postgresql/18/bin:/usr/bin:/bin",
        HOME: "/tmp/work/home",
        TMPDIR: "/tmp/work/tmp",
        LANG: "C.UTF-8",
        CI: "true",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        HOMELAB_TEST_DATABASE_URL:
            "postgres://homelab_test@127.0.0.1:55432/homelab_auth_test",
    });
    await rejects(
        runDaytonaChecks({ id, commit, patchSha256: null }, signal),
        new RegExp("qualified non-root")
    );
});

test("sandbox patch and output files reject substitution, oversized data and replay", async () => {
    const directory = await temporary();
    try {
        const inputs = await createSandboxDirectory(directory, "inputs");
        await rejects(createSandboxDirectory(directory, "inputs"));
        await rejects(createSandboxDirectory(directory, "../outside"));
        const file = path.join(inputs, "changes.txt");
        await writeFile(file, "reviewed patch");
        expect(
            new TextDecoder().decode(await readSandboxPatch(file, hash("reviewed patch")))
        ).toBe("reviewed patch");
        await rejects(
            readSandboxPatch(file, hash("different")),
            new RegExp("reviewed bytes")
        );
        await rejects(readSandboxPatch(file, "not-a-hash"), new RegExp("digest"));
        await symlink(file, path.join(inputs, "linked.txt"));
        await rejects(
            readSandboxPatch(path.join(inputs, "linked.txt"), hash("reviewed patch"))
        );
        await writeFile(file, "x".repeat(1_048_577));
        await rejects(readSandboxPatch(file, hash("x")), new RegExp("regular file"));
        await writeFile(file, "");
        await rejects(readSandboxPatch(file, hash("")), new RegExp("regular file"));
        await rejects(readSandboxPatch(inputs, hash("x")));
        await writeSandboxArtifact(directory, "check-log.txt", "result");
        expect(await readFile(path.join(directory, "check-log.txt"), "utf8")).toBe(
            "result"
        );
        await rejects(writeSandboxArtifact(directory, "check-log.txt", "overwrite"));
        await rejects(writeSandboxArtifact(directory, "../outside.txt", "escape"));
        await rejects(writeSandboxArtifact(directory, "huge.txt", "x".repeat(1_048_577)));
        await symlink(inputs, path.join(directory, "alias"));
        await rejects(createSandboxDirectory(path.join(directory, "alias"), "child"));
        await rejects(
            writeSandboxArtifact(path.join(directory, "alias"), "alias.txt", "x")
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("sandbox subprocess uses literal argv, an explicit environment and bounded output tails", async () => {
    const cwd = await temporary();
    try {
        const result = await runSandboxProcess(
            [
                process.execPath,
                "--no-env-file",
                "-e",
                "console.log(JSON.stringify({arg:process.argv[1],secret:process.env.HOMELAB_TEST_SENTINEL??null,keys:Object.keys(process.env)}))",
                "$(touch should-not-exist); literal",
            ],
            { cwd, env: { ONLY: "allowed" }, signal, timeoutMs: 5000 }
        );
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            arg: "$(touch should-not-exist); literal",
            secret: null,
        });
        expect(JSON.parse(result.stdout)).toMatchObject({ keys: ["ONLY"] });
        const noisy = await runSandboxProcess(
            [
                process.execPath,
                "--no-env-file",
                "-e",
                'process.stdout.write("x".repeat(100000));process.stderr.write("y".repeat(100000))',
            ],
            { cwd, env: {}, signal, timeoutMs: 5000, maxBytes: 1024 }
        );
        expect(noisy).toMatchObject({ exitCode: 0, truncated: true, timedOut: false });
        expect(
            Buffer.byteLength(noisy.stdout) + Buffer.byteLength(noisy.stderr)
        ).toBeLessThanOrEqual(1024);
        expect(noisy.stdout.endsWith("xxx")).toBe(true);
        await rejects(
            runSandboxProcess([], { cwd, env: {}, signal, timeoutMs: 1 }),
            new RegExp("bounds")
        );
        await rejects(
            runSandboxProcess(["missing-homelab-executable"], {
                cwd,
                env: {},
                signal,
                timeoutMs: 1000,
            })
        );
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

test("sandbox timeout and cancellation terminate commands and inherited child processes", async () => {
    const cwd = await temporary();
    try {
        const command = [
            process.execPath,
            "--no-env-file",
            "-e",
            "await Bun.sleep(10000)",
        ];
        const timed = await runSandboxProcess(command, {
            cwd,
            env: {},
            signal,
            timeoutMs: 100,
        });
        expect(timed.timedOut).toBe(true);
        expect(timed.exitCode).not.toBe(0);
        const controller = new AbortController();
        const pending = runSandboxProcess(command, {
            cwd,
            env: {},
            signal: controller.signal,
            timeoutMs: 5000,
        });
        controller.abort();
        const cancelled = await pending;
        expect(cancelled.exitCode).not.toBe(0);
        await rejects(
            runSandboxProcess(command, {
                cwd,
                env: {},
                signal: controller.signal,
                timeoutMs: 5000,
            })
        );
        const childScript =
            'await Bun.sleep(300); await Bun.write("orphan.txt","escaped");';
        await runSandboxProcess(
            [
                process.execPath,
                "--no-env-file",
                "-e",
                `Bun.spawn([process.execPath,"--no-env-file","-e",${JSON.stringify(childScript)}],{stdout:"inherit",stderr:"inherit"});process.exit(0)`,
            ],
            { cwd, env: {}, signal, timeoutMs: 2000 }
        );
        await Bun.sleep(400);
        expect(await Bun.file(path.join(cwd, "orphan.txt")).exists()).toBe(false);
    } finally {
        await rm(cwd, { recursive: true, force: true });
    }
});

async function workflowFixture(mode: string, patchText: string | null = null) {
    const directory = await temporary();
    if (patchText !== null) {
        const inputs = await createSandboxDirectory(directory, "inputs");
        await writeFile(path.join(inputs, "changes.txt"), patchText);
    }
    const calls: string[][] = [];
    const controller = new AbortController();
    const execute: typeof runSandboxProcess = async (args, options) => {
        calls.push([...args]);
        options.signal.throwIfAborted();
        const result = {
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            truncated: false,
        };
        if (args.includes("checkout")) {
            await writeFile(
                path.join(directory, "work/repo/.bun-version"),
                mode === "wrong-bun" ? "0.0.0" : "1.4.4"
            );
        }
        if (args.includes("rev-parse"))
            result.stdout = mode === "wrong-commit" ? "b".repeat(40) : commit;
        if (args.includes("--cached")) {
            result.stdout = patchText ?? "";
            result.truncated = mode === "large-diff";
        }
        if (args[0] === "pg_isready") result.exitCode = 0;
        if (args[0] === "postgres") {
            if (mode === "database-spawn") throw new Error("Synthetic spawn failure");
            return new Promise((resolve) =>
                options.signal.addEventListener(
                    "abort",
                    () =>
                        resolve({
                            ...result,
                            exitCode: mode === "database-exit" ? 1 : 0,
                        }),
                    { once: true }
                )
            );
        }
        if (args[0] === "pg_ctl" && mode === "database-stop")
            throw new Error("Synthetic stop failure");
        if (args[0] === "bun" && args[1] === "run") {
            if (mode === "check-failure" && args[2] === "check")
                return { ...result, exitCode: 1, stderr: "Synthetic check failure" };
            if (mode === "cancel") {
                controller.abort();
                throw new Error("Cancelled");
            }
            if (mode === "long-log")
                return { ...result, stdout: "x".repeat(150_000), truncated: true };
        }
        return result;
    };
    return {
        directory,
        execute,
        controller,
        calls,
        close: () => rm(directory, { recursive: true, force: true }),
    };
}

test.each([
    "success",
    "check-failure",
    "cancel",
    "wrong-commit",
    "wrong-bun",
    "large-diff",
    "database-spawn",
    "database-exit",
    "database-stop",
    "long-log",
])(
    "fixed check workflow records %s without replaying or hiding incomplete checks",
    async (mode) => {
        const f = await workflowFixture(mode);
        try {
            const code = await executeDaytonaChecks(
                { id, commit, patchSha256: null },
                f.directory,
                f.controller.signal,
                f.execute
            );
            expect(code).toBe(["success", "long-log"].includes(mode) ? 0 : 1);
            const report = JSON.parse(
                await readFile(
                    path.join(f.directory, "outputs/check-result.json"),
                    "utf8"
                )
            ) as {
                ok: boolean;
                failure: string | null;
                databaseStopped: boolean;
                logTruncated: boolean;
                steps: { name: string; exitCode: number }[];
            };
            expect(report.ok).toBe(code === 0);
            if (mode.startsWith("database-")) expect(report.databaseStopped).toBe(false);
            if (mode === "check-failure") {
                expect(report.steps.find((step) => step.name === "check")?.exitCode).toBe(
                    1
                );
                expect(report.steps.some((step) => step.name === "test:smoke")).toBe(
                    true
                );
            }
            if (mode === "cancel") expect(report.failure).toContain("interrupted");
            if (mode === "long-log") {
                expect(report.logTruncated).toBe(true);
                const log = await readFile(
                    path.join(f.directory, "outputs/check-log.txt")
                );
                expect(log.length).toBeLessThanOrEqual(750_003);
            }
            if (mode === "wrong-commit" || mode === "wrong-bun" || mode === "large-diff")
                expect(f.calls.some((args) => args[0] === "initdb")).toBe(false);
            expect(
                await readFile(path.join(f.directory, "outputs/changes.txt"), "utf8")
            ).toBe("# No patch supplied.\n");
        } finally {
            await f.close();
        }
    }
);

test.each([true, false])(
    "workflow binds the selected patch before running repository scripts (matching=%s)",
    async (matching) => {
        const f = await workflowFixture("success", "reviewed patch");
        try {
            const code = await executeDaytonaChecks(
                {
                    id,
                    commit,
                    patchSha256: hash(matching ? "reviewed patch" : "changed"),
                },
                f.directory,
                signal,
                f.execute
            );
            expect(code).toBe(matching ? 0 : 1);
            const apply = f.calls.filter((args) => args.includes("apply"));
            expect(apply).toHaveLength(matching ? 2 : 0);
            expect(
                f.calls.some((args) => args[0] === "bun" && args[1] === "install")
            ).toBe(matching);
            expect(
                await readFile(path.join(f.directory, "outputs/changes.txt"), "utf8")
            ).toBe(
                matching
                    ? "reviewed patch"
                    : "# Normalized patch unavailable. See check-result.json.\n"
            );
        } finally {
            await f.close();
        }
    }
);
