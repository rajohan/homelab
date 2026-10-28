import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import information from "../../../package.json";
import { readMiraPdf } from "../files/content";
import { CodexRuntime } from "../runtime/codexRuntime";
import { pilotArguments, pilotEnvironment } from "../runtime/configuration";
import { validatePilot } from "../runtime/validatePilot";
import { syntheticPdf } from "./document";

/**
 * Verify the actual Mira artifact includes executable native runtimes and an isolated PDF parser.
 * @returns Completion without login, credentials, network access or paid model requests.
 */
export async function main(): Promise<void> {
    const root = await mkdtemp(path.join(tmpdir(), "homelab-mira-smoke-"));
    let runtime: CodexRuntime | undefined;
    try {
        const codexHome = path.join(root, "profile"),
            workspace = path.join(root, "workspace");
        await mkdir(codexHome, { mode: 0o700 });
        await mkdir(workspace, { mode: 0o700 });
        const command = fileURLToPath(
            new URL(
                `runtime/${process.platform === "win32" ? "codex.exe" : "codex"}`,
                import.meta.url
            )
        );
        const config = await validatePilot({ command, codexHome, workspace });
        const version = Bun.spawnSync([command, "--version"], {
            env: pilotEnvironment(config, {}),
            stderr: "pipe",
            stdout: "pipe",
        });
        assert.equal(version.exitCode, 0);
        assert.equal(
            version.stdout.toString().trim(),
            `codex-cli ${information.dependencies["@openai/codex"]}`
        );
        const host = Bun.spawn(
            [
                path.join(
                    path.dirname(command),
                    `codex-code-mode-host${process.platform === "win32" ? ".exe" : ""}`
                ),
                "--help",
            ],
            {
                env: pilotEnvironment(config, {}),
                cwd: workspace,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "ignore",
            }
        );
        const deadline = setTimeout(() => host.kill("SIGKILL"), 10_000);
        try {
            const [code, output] = await Promise.all([
                host.exited,
                new Response(host.stdout).text(),
            ]);
            assert.equal(code, 0, "The packaged code-mode host could not execute.");
            assert.match(output, /Usage: codex-code-mode-host/);
            assert.match(output, /grpc\+stdio:\/\//);
        } finally {
            clearTimeout(deadline);
        }
        runtime = await CodexRuntime.connect({
            command,
            args: pilotArguments(),
            cwd: workspace,
            env: pilotEnvironment(config, {}),
            requestTimeoutMs: 10_000,
        });
        const account = await runtime.account();
        assert.equal(account.authenticated, false);
        const pdf = await readMiraPdf(syntheticPdf(), AbortSignal.timeout(10_000));
        assert.match(pdf.text, /Synthetic Mira document/);
        process.stdout.write("MIRA_SMOKE_OK\n");
    } finally {
        await runtime?.close();
        await rm(root, { recursive: true, force: true });
    }
}

if (import.meta.main) await main();
