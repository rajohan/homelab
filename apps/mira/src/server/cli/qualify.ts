import { lstat, realpath } from "node:fs/promises";

import { Effect } from "effect";

import { qualifyRuntime } from "../qualification";
import { parsePilotConfig } from "../runtime/configuration";

/**
 * Run the explicitly requested runtime pilot using an external nonsecret JSON config.
 * @returns Completion with a nonzero exit status if any qualification fails.
 */
export async function main(): Promise<void> {
    const configPath = process.argv[2];
    if (!configPath || process.argv.length !== 3)
        throw new Error("Usage: bun run mira:qualify /absolute/path/to/pilot.json");
    const config = parsePilotConfig(await Bun.file(configPath).json());
    for (const path of [config.codexHome, config.workspace]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new Error("Pilot directories must be real existing directories.");
    }
    parsePilotConfig({
        ...config,
        codexHome: await realpath(config.codexHome),
        workspace: await realpath(config.workspace),
    });
    const result = await Effect.runPromise(
        qualifyRuntime(config, (message) => {
            process.stdout.write(message + "\n");
        })
    );
    process.stdout.write(JSON.stringify(result) + "\n");
}

if (import.meta.main) await main();
