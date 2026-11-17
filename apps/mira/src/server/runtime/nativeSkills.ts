import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import {
    nativeSkillEngine,
    skillEngineMaxBytes,
} from "@homelab/contracts/miraSkillEngine";
import type { MiraSkillId } from "@homelab/contracts/miraSkills";
import * as v from "valibot";

import { bundledNativeMiraSkills, describeMiraSkillPackages } from "../skills/catalog";

export interface NativeSkill {
    name: string;
    path: string;
}
export interface NativeSkills {
    roots: string[];
    skills: NativeSkill[];
}

/**
 * Locate original native entrypoints without rewriting their frontmatter or references.
 * @param command - Canonical packaged Codex executable.
 * @param enabled - Current owner's enabled release package identifiers.
 * @returns Process-local discovery roots and exact expected native names and paths.
 */
export function describeNativeSkills(
    command: string,
    enabled: readonly MiraSkillId[]
): NativeSkills {
    const result: NativeSkills = { roots: [], skills: [] };
    const names = new Set<string>();
    for (const entry of bundledNativeMiraSkills()) {
        if (!enabled.includes(entry.id)) continue;
        const root = path.join(path.dirname(command), "skills", entry.id);
        const relative = path.posix.dirname(path.posix.dirname(entry.entrypoint));
        // Codex namespaces skills when their unchanged parent has plugin metadata.
        const plugin = entry.files[".claude-plugin/plugin.json"];
        const namespace = plugin
            ? v.parse(
                  v.object({
                      name: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)),
                  }),
                  JSON.parse(plugin)
              ).name
            : null;
        result.roots.push(path.join(root, relative));
        for (const [file, content] of Object.entries(entry.files)) {
            if (
                !file.endsWith("/SKILL.md") ||
                path.posix.dirname(path.posix.dirname(file)) !== relative
            )
                continue;
            const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
            if (!frontmatter) throw new Error("Native skill frontmatter is missing.");
            const { name } = v.parse(
                v.object({
                    name: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/)),
                }),
                Bun.YAML.parse(frontmatter[1]!)
            );
            const nativeName = namespace ? `${namespace}:${name}` : name;
            if (names.has(nativeName))
                throw new Error("Native skill names must be unique.");
            names.add(nativeName);
            result.skills.push({ name: nativeName, path: path.join(root, file) });
        }
    }
    if (result.roots.length > 0 && result.skills.length === 0)
        throw new Error("Native skill entrypoints are missing.");
    return result;
}

async function verifyFile(file: string, content: string): Promise<void> {
    const expected = Buffer.from(content, "utf8");
    const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== expected.length)
            throw new Error("Native skill source size changed.");
        const bytes = Buffer.alloc(expected.length + 1);
        let length = 0;
        while (length < bytes.length) {
            const { bytesRead } = await handle.read(
                bytes,
                length,
                bytes.length - length,
                length
            );
            if (!bytesRead) break;
            length += bytesRead;
        }
        if (length !== expected.length || !bytes.subarray(0, length).equals(expected))
            throw new Error("Native skill source differs from the reviewed release.");
    } finally {
        await handle.close();
    }
}

async function verifyEngine(file: string, expected: string): Promise<void> {
    const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
        const stat = await handle.stat();
        if (
            !stat.isFile() ||
            stat.size === 0 ||
            stat.size > skillEngineMaxBytes ||
            (process.platform !== "win32" && !(stat.mode & 0o111))
        )
            throw new Error("Native skill engine is not an executable regular file.");
        const hasher = new Bun.CryptoHasher("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let position = 0;
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (!bytesRead) break;
            position += bytesRead;
            if (position > skillEngineMaxBytes)
                throw new Error("Native skill engine exceeds its size limit.");
            hasher.update(buffer.subarray(0, bytesRead));
        }
        if (position !== stat.size || hasher.digest("hex") !== expected)
            throw new Error("Native skill engine differs from its upstream checksum.");
    } finally {
        await handle.close();
    }
}

/**
 * Verify the installed originals before native Codex can discover or inject them.
 * @param command - Canonical packaged executable, with immutable skills installed beside it.
 * @param enabled - Only packages enabled for this owner's run; no shared profile mutation.
 * @returns Verified discovery roots and native entrypoints, rejecting links, extra or modified files.
 */
export async function readNativeSkills(
    command: string,
    enabled: readonly MiraSkillId[]
): Promise<NativeSkills> {
    const result = describeNativeSkills(command, enabled);
    if (result.roots.length === 0) return result;
    const root = path.join(path.dirname(command), "skills");
    if ((await realpath(root)) !== root)
        throw new Error("Native skill installation must not contain links.");
    for (const entry of bundledNativeMiraSkills()) {
        if (!enabled.includes(entry.id)) continue;
        const engine = nativeSkillEngine(entry, process.platform, process.arch);
        const seen = new Set<string>();
        const directories = new Set<string>();
        for (const file of [
            ...Object.keys(entry.files),
            ...(engine ? [engine.path] : []),
        ]) {
            let directory = path.posix.dirname(file);
            while (directory !== ".") {
                directories.add(directory);
                directory = path.posix.dirname(directory);
            }
        }
        const visit = async (directory: string, prefix: string): Promise<void> => {
            const stat = await lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                throw new Error("Native skill directories must not contain links.");
            for (const item of await readdir(directory, { withFileTypes: true })) {
                const key = prefix + item.name;
                const file = path.join(directory, item.name);
                if (item.isDirectory() && directories.has(key))
                    await visit(file, key + "/");
                else if (item.isFile() && engine && key === engine.path) {
                    await verifyEngine(file, engine.sha256);
                    seen.add(key);
                } else if (item.isFile() && Object.hasOwn(entry.files, key)) {
                    await verifyFile(file, entry.files[key]!);
                    seen.add(key);
                } else
                    throw new Error(
                        "Native skill installation contains an unexpected entry."
                    );
            }
        };
        await visit(path.join(root, entry.id), "");
        if (seen.size !== Object.keys(entry.files).length + (engine ? 1 : 0))
            throw new Error("Native skill installation is incomplete.");
    }
    return result;
}

/**
 * Resolve explicit Codex skill mentions to verified native inputs.
 * @param text - Current user turn or steering text; a mention grants no execution authority.
 * @param skills - Current run's enabled and verified native entrypoints.
 * @returns Deduplicated native skill selections; unknown or paused skills are never selected.
 */
export function nativeSkillInputs(text: string, skills: readonly NativeSkill[]) {
    const names = new Set(
        Array.from(text.matchAll(/\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)/g), (match) => match[1])
    );
    return skills
        .filter((skill) => names.has(skill.name))
        .map((skill) => ({ type: "skill" as const, name: skill.name, path: skill.path }));
}

/**
 * Map installed native paths to the existing bounded reader for referenced resources.
 * @param command - Trusted packaged native executable.
 * @param enabled - Current owner's enabled original source packages.
 * @returns Host integration guidance kept separate from unchanged upstream instructions.
 */
export function nativeSkillGuidance(
    command: string,
    enabled: readonly MiraSkillId[]
): string {
    const packages = describeMiraSkillPackages().filter(
        (entry) => enabled.includes(entry.id) && entry.revision
    );
    if (packages.length === 0) return "";
    const mappings = packages.map((entry) => ({
        id: entry.id,
        packageHash: entry.packageHash,
        root: path.join(path.dirname(command), "skills", entry.id),
    }));
    return `Original upstream and Homelab skills are installed and registered with native Codex discovery. Follow their complete SKILL.md and applicable references. Read referenced files through mira_skill_read: resolve the reference relative to the current native file, remove the matching package root below, and use that repository-relative file key with its id and packageHash. Follow nextOffset for long files. These mappings provide file access, not replacement skill instructions. Project inspection, editing, rendered verification and execution use the current supplied tools and permissions. Impeccable includes its original executable launcher and version-pinned native engine in the documented sibling location. Invoke its original commands through an authorized execution tool with cwd set to the project being worked on. The skill files are not a project checkout. Installation does not grant execution authority or register hooks and agents. If a required tool is unavailable in a run, use the original documented fallback and report the limitation. Native package mappings: ${JSON.stringify(mappings)}`;
}
