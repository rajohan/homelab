import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dependencies } from "../package.json";

/** Extract system-skill fingerprints from the same native binary shipped by the build.
 * @param command - Absolute packaged Codex executable from the frozen install.
 * @returns Completion after writing its generated manifest and removing the temporary profile.
 */
export async function buildSystemSkills(command: string): Promise<void> {
    const temporary = await mkdtemp(path.join(tmpdir(), "homelab-codex-build-"));
    let runtime: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
    try {
        const config = {
            command,
            codexHome: path.join(temporary, "home"),
            workspace: path.join(temporary, "workspace"),
        };
        await mkdir(config.codexHome, { mode: 0o700 });
        await mkdir(config.workspace, { mode: 0o700 });
        const env: Record<string, string> = {
            CODEX_HOME: config.codexHome,
            HOME: config.codexHome,
            USERPROFILE: config.codexHome,
        };
        for (const key of [
            "PATH",
            "Path",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
        ])
            if (process.env[key]) env[key] = process.env[key];
        const version = Bun.spawnSync([command, "--version"], {
            cwd: config.workspace,
            env,
            timeout: 5000,
            stdout: "pipe",
            stderr: "ignore",
        });
        if (
            version.exitCode !== 0 ||
            version.stdout.toString().trim() !==
                `codex-cli ${dependencies["@openai/codex"]}`
        )
            throw new Error("The packaged Codex executable does not match package.json.");
        runtime = Bun.spawn([command, "app-server", "--listen", "stdio://"], {
            cwd: config.workspace,
            env,
            stdin: "pipe",
            stdout: "pipe",
            stderr: "ignore",
            timeout: 15_000,
        });
        await runtime.stdin.write(
            JSON.stringify({
                id: 1,
                method: "initialize",
                params: {
                    clientInfo: { name: "homelab_build", version: "1.0.0" },
                    capabilities: { experimentalApi: true },
                },
            }) + "\n"
        );
        let initialized = false;
        let pending = "";
        const decoder = new TextDecoder();
        for await (const chunk of runtime.stdout) {
            pending += decoder.decode(chunk, { stream: true });
            if (pending.length > 1_000_000)
                throw new Error("Unexpected Codex build response.");
            let newline: number;
            while ((newline = pending.indexOf("\n")) >= 0) {
                const message = JSON.parse(pending.slice(0, newline)) as {
                    id?: number;
                    error?: unknown;
                    result?: unknown;
                };
                pending = pending.slice(newline + 1);
                if (message.id !== 1) continue;
                if (message.error || !message.result)
                    throw new Error("Codex build initialization failed.");
                initialized = true;
                await runtime.stdin.end();
            }
        }
        if ((await runtime.exited) !== 0 || !initialized)
            throw new Error("Codex build discovery failed.");
        runtime = undefined;
        const entries: Record<string, string | null> = {};
        async function visit(directory: string, prefix = ""): Promise<void> {
            for (const entry of await readdir(directory, { withFileTypes: true })) {
                if (!prefix && entry.name === ".codex-system-skills.marker") continue;
                const file = path.join(directory, entry.name);
                const key = prefix + entry.name;
                if (entry.isDirectory()) {
                    entries[key + "/"] = null;
                    await visit(file, key + "/");
                } else if (entry.isFile()) {
                    entries[key] = new Bun.CryptoHasher("sha256")
                        .update(await readFile(file))
                        .digest("hex");
                } else
                    throw new Error(
                        "Unexpected entry in the packaged Codex skill bundle."
                    );
            }
        }
        await visit(path.join(config.codexHome, "skills", ".system"));
        if (!Object.keys(entries).some((file) => file.endsWith("/SKILL.md")))
            throw new Error("The packaged Codex skill bundle is empty.");
        await Bun.write(
            path.join(path.dirname(command), "system-skills.json"),
            JSON.stringify({ version: dependencies["@openai/codex"], entries })
        );
    } finally {
        if (runtime) {
            runtime.kill();
            await runtime.exited;
        }
        await rm(temporary, { recursive: true, force: true });
    }
}
