import { Effect } from "effect";

import { validatePilot } from "../runtime/validatePilot";
import { qualifyVisualRuntime } from "../visualQualification";

/**
 * Run the explicitly requested synthetic vision qualification using Mira's isolated profile.
 * @returns Completion with a nonzero exit status if image delivery or interpretation fails.
 */
export async function main(): Promise<void> {
    const configPath = process.argv[2];
    if (!configPath || process.argv.length !== 3)
        throw new Error(
            "Usage: bun run mira:qualify-visual /absolute/path/to/pilot.json"
        );
    const config = await validatePilot(await Bun.file(configPath).json());
    const result = await Effect.runPromise(
        qualifyVisualRuntime(config, (message) => process.stdout.write(message + "\n"))
    );
    process.stdout.write(JSON.stringify(result) + "\n");
}

if (import.meta.main) await main();
