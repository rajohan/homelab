import { Effect } from "effect";

import { qualifyRuntime } from "../qualification";
import { validatePilot } from "../runtime/validatePilot";

/**
 * Run the explicitly requested runtime pilot using an external nonsecret JSON config.
 * @returns Completion with a nonzero exit status if any qualification fails.
 */
export async function main(): Promise<void> {
    const configPath = process.argv[2];
    if (!configPath || process.argv.length !== 3)
        throw new Error("Usage: bun run mira:qualify /absolute/path/to/pilot.json");
    const config = await validatePilot(await Bun.file(configPath).json());
    const result = await Effect.runPromise(
        qualifyRuntime(config, (message) => {
            process.stdout.write(message + "\n");
        })
    );
    process.stdout.write(JSON.stringify(result) + "\n");
}

if (import.meta.main) await main();
