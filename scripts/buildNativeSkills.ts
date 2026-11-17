import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { verifySkills } from "./verifySkills";

/**
 * Install unchanged upstream trees beside Codex in the existing release build.
 * @param command - Packaged native executable in the freshly cleaned build output.
 * @returns Completion after all original sources and relative resources are verified; no installer or upstream script runs.
 */
export async function buildNativeSkills(command: string): Promise<void> {
    const packages = await verifySkills();
    for (const entry of packages) {
        for (const [file, content] of Object.entries(entry.files)) {
            const target = path.join(path.dirname(command), "skills", entry.id, file);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, content, {
                encoding: "utf8",
                flag: "wx",
                mode: 0o444,
            });
        }
    }
}
