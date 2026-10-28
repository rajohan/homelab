import path from "node:path";

import { buildComputer } from "./buildComputer";
import { buildWindowsConsent } from "./buildWindowsConsent";
import { buildWindowsWorker } from "./buildWindowsWorker";

/**
 * Build one complete Windows companion package from the locked repository dependencies.
 * @param outputRoot - Absolute build root; its windows-x64 subdirectory must be absent or empty.
 * @returns Fixed sibling executable paths; this builder neither installs nor starts the companion.
 */
export async function buildWindowsComputer(outputRoot: string) {
    if (!path.isAbsolute(outputRoot))
        throw new Error("Computer output must be absolute.");
    const directory = path.join(outputRoot, "windows-x64");
    const worker = await buildWindowsWorker(directory);
    const { host: consent } = await buildWindowsConsent(directory);
    const companion = await buildComputer("windows-x64", outputRoot);
    return { directory, companion, consent, ...worker };
}

if (import.meta.main) {
    const [directory, ...extra] = process.argv.slice(2);
    if (!directory || extra.length > 0)
        throw new Error(
            "Provide one absolute output root with an empty windows-x64 subdirectory."
        );
    console.info(await buildWindowsComputer(directory));
}
