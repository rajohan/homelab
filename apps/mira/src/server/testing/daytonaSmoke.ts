import assert from "node:assert/strict";

import { sandboxSmokeEnvironment } from "../config/environment";
import { runSandboxProcess } from "../sandbox/process";
import { daytonaCheckProfile } from "../sandbox/profile";

/**
 * Exercise the actual disposable image without host mounts or provider credentials.
 * @returns Completion only after the public exact-commit checks, artifact recovery and container removal succeed.
 */
export async function main(): Promise<void> {
    const [commit, image = "homelab-daytona-harness:tested", ...extra] =
        process.argv.slice(2);
    assert.ok(
        commit && /^[a-f0-9]{40}$/.test(commit) && extra.length === 0,
        "An exact public source commit is required."
    );
    assert.ok(/^[a-z0-9][a-z0-9./:_-]{1,200}$/.test(image), "Invalid local image name.");
    const name = `homelab-daytona-smoke-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    const signal = AbortSignal.timeout(720_000);
    const docker = async (args: string[], timeoutMs = 30_000) => {
        const result = await runSandboxProcess(["docker", ...args], {
            cwd: process.cwd(),
            env: sandboxSmokeEnvironment(),
            signal,
            timeoutMs,
            maxBytes: 131_072,
        });
        assert.ok(
            !result.timedOut && !result.truncated,
            "Docker command exceeded its bounds."
        );
        return result;
    };
    let createAttempted = false;
    let created = false;
    try {
        createAttempted = true;
        const start = await docker([
            "run",
            "-d",
            "--name",
            name,
            "--workdir",
            "/tmp",
            "--read-only",
            "--cpus",
            "2",
            "--memory",
            "4g",
            "--pids-limit",
            "1024",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,exec,size=2147483648",
            "--entrypoint",
            "sleep",
            image,
            "infinity",
        ]);
        assert.equal(start.exitCode, 0, start.stderr);
        created = true;
        const result = await docker(
            [
                "exec",
                "--workdir",
                "/tmp",
                name,
                "bun",
                "--no-env-file",
                daytonaCheckProfile.executable,
                id,
                commit,
            ],
            660_000
        );
        const reportFile = await docker([
            "exec",
            "--workdir",
            "/tmp",
            name,
            "cat",
            `/tmp/homelab-mira/${id}/outputs/check-result.json`,
        ]);
        assert.equal(reportFile.exitCode, 0, result.stderr + reportFile.stderr);
        const report: unknown = JSON.parse(reportFile.stdout);
        assert.ok(
            report && typeof report === "object" && "ok" in report && "steps" in report
        );
        if (!report.ok) {
            const log = await docker([
                "exec",
                "--workdir",
                "/tmp",
                name,
                "tail",
                "-c",
                "48000",
                `/tmp/homelab-mira/${id}/outputs/check-log.txt`,
            ]);
            process.stderr.write(log.stdout);
        }
        assert.equal(result.exitCode, 0, reportFile.stdout);
        assert.equal(report.ok, true, reportFile.stdout);
        assert.deepEqual(
            Object.fromEntries(
                Object.entries(report).filter(([key]) =>
                    [
                        "commit",
                        "bun",
                        "trust",
                        "databaseStopped",
                        "inputPatchSha256",
                    ].includes(key)
                )
            ),
            {
                commit,
                bun: "1.4.4",
                trust: "untrusted_sandbox_result",
                databaseStopped: true,
                inputPatchSha256: null,
            }
        );
        assert.ok(Array.isArray(report.steps));
        for (const task of [
            "check",
            "db:check:auth",
            "db:check:dashboard",
            "test",
            "test:integration",
            "build",
            "test:smoke",
        ])
            assert.ok(
                report.steps.some(
                    (step: { name: string; exitCode: number }) =>
                        step.name === task && step.exitCode === 0
                ),
                `Missing required check: ${task}`
            );
        for (const output of daytonaCheckProfile.outputs) {
            const file = await docker([
                "exec",
                "--workdir",
                "/tmp",
                name,
                "stat",
                "-c",
                "%s",
                `/tmp/homelab-mira/${id}/outputs/${output}`,
            ]);
            assert.equal(file.exitCode, 0);
            assert.ok(Number(file.stdout) > 0 && Number(file.stdout) <= 1_048_576);
        }
        // Replaying an attempt must fail before overwriting any result or starting another checkout.
        const replay = await docker([
            "exec",
            "--workdir",
            "/tmp",
            name,
            "bun",
            "--no-env-file",
            daytonaCheckProfile.executable,
            id,
            commit,
        ]);
        assert.notEqual(replay.exitCode, 0);
        const unchanged = await docker([
            "exec",
            "--workdir",
            "/tmp",
            name,
            "cat",
            `/tmp/homelab-mira/${id}/outputs/check-result.json`,
        ]);
        assert.equal(unchanged.stdout, reportFile.stdout);
        process.stdout.write("DAYTONA_IMAGE_SMOKE_OK\n");
    } finally {
        if (createAttempted) {
            const removal = await runSandboxProcess(
                ["docker", "rm", "--force", "--volumes", name],
                {
                    cwd: process.cwd(),
                    env: sandboxSmokeEnvironment(),
                    signal: AbortSignal.timeout(30_000),
                    timeoutMs: 30_000,
                    maxBytes: 4096,
                }
            );
            assert.ok(
                removal.exitCode === 0 ||
                    (!created && removal.stderr.includes(`No such container: ${name}`)),
                "Disposable image cleanup failed."
            );
        }
    }
}
if (import.meta.main) await main();
