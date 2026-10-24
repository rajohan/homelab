import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parsePilotConfig, type PilotConfig } from "./configuration";

async function exists(file: string): Promise<boolean> {
    try {
        await lstat(file);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

/**
 * Resolve paths once and reject wrappers, nonempty workspaces and inherited config.
 * @param input - Operator-owned configuration; no paths may come from a model.
 * @returns Canonical paths that must be used for both the child environment and cwd.
 */
export async function validatePilot(input: unknown): Promise<PilotConfig> {
    const parsed = parsePilotConfig(input);
    const config = parsePilotConfig({
        ...parsed,
        command: await realpath(parsed.command),
        codexHome: await realpath(parsed.codexHome),
        workspace: await realpath(parsed.workspace),
    });
    for (const directory of [config.codexHome, config.workspace]) {
        const stat = await lstat(directory);
        if (!stat.isDirectory())
            throw new Error("Pilot directories must be real existing directories.");
    }
    const executable = await open(config.command, "r");
    try {
        const header = Buffer.alloc(4);
        await executable.read(header, 0, 4, 0);
        const magic = header.toString("hex");
        if (
            ![
                "7f454c46", // ELF
                "cffaedfe", // Mach-O 64-bit
                "feedfacf",
                "cafebabe", // Universal Mach-O
                "bebafeca",
            ].includes(magic) &&
            !magic.startsWith("4d5a") // Windows PE
        )
            throw new Error("Mira requires a native Codex executable, not a wrapper.");
    } finally {
        await executable.close();
    }
    const contents = await readdir(config.workspace);
    if (contents.length > 0)
        throw new Error("Mira requires an empty standalone workspace.");
    for (let directory = config.workspace; ; directory = path.dirname(directory)) {
        for (const name of [
            ".git",
            ".codex",
            ".agents",
            "AGENTS.md",
            "AGENTS.override.md",
        ])
            if (await exists(path.join(directory, name)))
                throw new Error("Mira workspace inherits project configuration.");
        if (path.dirname(directory) === directory) break;
    }
    for (const name of ["AGENTS.md", "AGENTS.override.md", ".agents"])
        if (await exists(path.join(config.codexHome, name)))
            throw new Error("Mira runtime home contains inherited instructions.");
    const skills = path.join(config.codexHome, "skills");
    if (await exists(skills)) {
        const entries = await readdir(skills);
        // Codex installs its versioned built-ins on first launch. Other skills are ambient authority.
        if (entries.some((entry) => entry !== ".system"))
            throw new Error("Mira runtime home contains custom skills.");
    }
    const configFile = path.join(config.codexHome, "config.toml");
    if (await exists(configFile)) {
        const content = await readFile(configFile, "utf8");
        if (content.trim())
            throw new Error("Mira requires a dedicated home without custom config.");
    }
    return config;
}
