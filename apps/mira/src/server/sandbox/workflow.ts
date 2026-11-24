import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { sandboxProxyEnvironment } from "../config/environment";
import { buildSandboxEdits, readSandboxSources } from "./edits";
import { createSandboxDirectory, readSandboxPatch, writeSandboxArtifact } from "./files";
import { runSandboxProcess, type SandboxProcessResult } from "./process";
import {
    daytonaCheckProfile,
    type DaytonaSandboxRequest,
    daytonaSandboxSchema,
} from "./profile";
const git = (...args: string[]) => [
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "http.followRedirects=false",
    ...args,
];

interface Step {
    name: string;
    exitCode: number;
    timedOut: boolean;
    truncated: boolean;
    milliseconds: number;
}
/**
 * Return a clean sandbox environment, never inheriting provider credentials or host configuration.
 * @param directory - Canonical fresh per-attempt directory.
 * @returns Explicit runtime and Git settings.
 */
export function sandboxEnvironment(directory: string): Record<string, string> {
    const tools = path.join(path.dirname(directory), "tools");
    const systemPath = "/usr/local/bin:/usr/bin:/bin";
    return {
        ...sandboxProxyEnvironment(),
        PATH:
            process.execPath === path.join(tools, "bun")
                ? tools + ":" + systemPath
                : systemPath,
        HOME: path.join(directory, "home"),
        TMPDIR: path.join(directory, "tmp"),
        LANG: "C.UTF-8",
        CI: "true",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
    };
}
/**
 * Execute the fixed workflow in one fresh attempt directory and record bounded passive results.
 * @param request - Validated exact public commit and optional selected patch digest.
 * @param attempt - Canonical disposable attempt directory provisioned by the image entry point.
 * @param stopping - Cancellation signal for this invocation.
 * @param execute - Subprocess boundary for the fixed checks.
 * @param announce - Status sink, defaulting to stdout outside the local JSON transport.
 * @param collect - Local stdio result sink. The cloud runner writes artifacts to its output directory.
 * @returns Exit status after recording the check results.
 */
export async function executeDaytonaChecks(
    request: DaytonaSandboxRequest,
    attempt: string,
    stopping: AbortSignal,
    execute: typeof runSandboxProcess = runSandboxProcess,
    announce: (message: string) => void = (message) => {
        process.stdout.write(message);
    },
    collect?: (name: string, text: string) => void
): Promise<number> {
    const input = v.parse(daytonaSandboxSchema, request);
    const editHash = "editsSha256" in input ? input.editsSha256 : null;
    const patchHash = "patchSha256" in input ? input.patchSha256 : null;
    const inputHash = editHash ?? patchHash;
    const inspecting = "paths" in input;
    const work = await createSandboxDirectory(attempt, "work");
    const outputs = collect
        ? undefined
        : await createSandboxDirectory(attempt, "outputs");
    const output = (name: string, text: string) =>
        collect ? collect(name, text) : writeSandboxArtifact(outputs!, name, text);
    const repo = await createSandboxDirectory(work, "repo");
    await createSandboxDirectory(work, "home");
    await createSandboxDirectory(work, "tmp");
    const env = sandboxEnvironment(work);
    const deadline = Date.now() + daytonaCheckProfile.minutes * 60_000;
    const signal = AbortSignal.any([
        stopping,
        AbortSignal.timeout(daytonaCheckProfile.minutes * 60_000),
    ]);
    const steps: Step[] = [];
    let log = "",
        logTruncated = false,
        patch = "",
        failure: string | null = null;
    const append = (text: string) => {
        const bytes = Buffer.from(log + text);
        if (bytes.length > 750_000) logTruncated = true;
        log = bytes.subarray(Math.max(0, bytes.length - 750_000)).toString("utf8");
    };
    const command = async (
        name: string,
        argv: string[],
        required = true,
        cwd = repo
    ): Promise<SandboxProcessResult> => {
        signal.throwIfAborted();
        const started = Date.now();
        const result = await execute(argv, {
            cwd,
            env,
            signal,
            timeoutMs: Math.max(1, Math.min(300_000, deadline - Date.now())),
            maxBytes: 65_536,
        });
        steps.push({
            name,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            truncated: result.truncated,
            milliseconds: Date.now() - started,
        });
        append(
            `\n--- ${name} (exit ${result.exitCode}) ---\n${result.stdout}${result.stderr}`
        );
        if (required && (result.exitCode !== 0 || result.timedOut))
            throw new Error(`Failed: ${name}`);
        return result;
    };
    try {
        await command("Initialize checkout", git("init", "--template="));
        await command(
            "Fetch exact public commit",
            git(
                "fetch",
                "--depth=1",
                "--no-tags",
                "--no-recurse-submodules",
                daytonaCheckProfile.repository,
                input.commit
            )
        );
        await command(
            "Checkout exact public commit",
            git("checkout", "--detach", "FETCH_HEAD")
        );
        const head = await command("Verify commit", git("rev-parse", "HEAD"));
        if (head.stdout.trim() !== input.commit)
            throw new Error("Checkout does not match the selected commit.");
        if ("paths" in input) {
            const tree = await execute(git("ls-files", "-z"), {
                cwd: repo,
                env,
                signal,
                timeoutMs: 30_000,
                maxBytes: 1_048_576,
            });
            if (tree.exitCode !== 0 || tree.timedOut || tree.truncated)
                throw new Error("Source tree exceeded its recovery limit.");
            await output(
                "source-tree.json",
                JSON.stringify(
                    {
                        commit: input.commit,
                        paths: tree.stdout.split("\0").filter(Boolean),
                        trust: "untrusted_repository_source",
                    },
                    null,
                    2
                ) + "\n"
            );
            await output(
                "source-files.json",
                await readSandboxSources(repo, input.commit, input.paths, signal)
            );
        } else {
            if (inputHash) {
                const inputs = path.join(attempt, "inputs");
                if ((await realpath(inputs)) !== inputs)
                    throw new Error("Input directory changed.");
                const bytes = await readSandboxPatch(
                    path.join(inputs, editHash ? "edits.json" : "changes.txt"),
                    inputHash
                );
                await writeSandboxArtifact(
                    work,
                    "selected-patch.txt",
                    editHash
                        ? await buildSandboxEdits(repo, input.commit, bytes, signal)
                        : new TextDecoder("utf-8", {
                              fatal: true,
                              ignoreBOM: true,
                          }).decode(bytes)
                );
                await command(
                    "Validate selected patch",
                    git(
                        "apply",
                        "--check",
                        "--index",
                        path.join(work, "selected-patch.txt")
                    )
                );
                await command(
                    "Apply selected patch",
                    git("apply", "--index", path.join(work, "selected-patch.txt"))
                );
            }
            const diff = await execute(
                git("diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv"),
                { cwd: repo, env, signal, timeoutMs: 30_000, maxBytes: 1_048_576 }
            );
            if (diff.exitCode !== 0 || diff.timedOut || diff.truncated)
                throw new Error("The normalized patch exceeded the recovery limit.");
            patch = diff.stdout;
            const selectedBun = await readFile(path.join(repo, ".bun-version"), "utf8");
            const selectedRevision = await readFile(
                path.join(repo, ".bun-revision"),
                "utf8"
            );
            if (
                selectedBun.trim() !== daytonaCheckProfile.bunVersion ||
                selectedRevision.trim() !== daytonaCheckProfile.bunRevision
            )
                throw new Error("The selected source requires a different Bun snapshot.");
            await command("Install frozen dependencies", [
                "bun",
                "install",
                "--frozen-lockfile",
                "--ignore-scripts",
            ]);
            for (const task of [
                "check",
                "db:check:auth",
                "db:check:dashboard",
                "build",
            ]) {
                await command(task, ["bun", "run", task], false);
            }
            await command(
                "Verify tracked files unchanged by checks",
                git("diff", "--exit-code", "--no-ext-diff", "--no-textconv"),
                false
            );
        }
    } catch (error) {
        if (signal.aborted)
            failure =
                "Sandbox checks were interrupted or reached their ten-minute deadline.";
        else failure = error instanceof Error ? error.message : "Sandbox check failed.";
    }
    const ok =
        failure === null && steps.every((step) => step.exitCode === 0 && !step.timedOut);
    if (!inspecting)
        await output(
            "changes.txt",
            patch ||
                (inputHash
                    ? "# Normalized patch unavailable. See check-result.json.\n"
                    : "# No patch supplied.\n")
        );
    await output("check-log.txt", log || "No subprocess output.\n");
    await output(
        "check-result.json",
        JSON.stringify(
            {
                profile: daytonaCheckProfile.version,
                repository: daytonaCheckProfile.repository,
                commit: input.commit,
                bun: Bun.version,
                ok,
                failure,
                logTruncated: logTruncated || steps.some((step) => step.truncated),
                inputPatchSha256: patchHash,
                inputEditsSha256: editHash,
                normalizedPatchSha256: patch
                    ? new Bun.CryptoHasher("sha256").update(patch).digest("hex")
                    : null,
                steps,
                trust: "untrusted_sandbox_result",
                scope: inspecting
                    ? "Source inspection only; no installation, repository checks or execution."
                    : "Repository checks only; no image builds, deployment or GitHub writes.",
            },
            null,
            2
        ) + "\n"
    );
    const operation = inspecting ? "source inspection" : "checks";
    announce(
        `Homelab ${operation} ${ok ? "completed" : "failed or was incomplete"}; retrieve the recorded results.\n`
    );
    return ok ? 0 : 1;
}
