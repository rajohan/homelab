import {
    skillSourceText,
    validateMiraSkillPackages,
} from "@homelab/contracts/miraSkillPackages";
import {
    type MiraSkillDocument,
    type MiraSkillId,
    type MiraSkillSummary,
} from "@homelab/contracts/miraSkills";
import { sourceDependencyConfigSchema } from "@homelab/contracts/sourceDependencies";
import * as v from "valibot";

import { config } from "../../../../../package.json";
import bundle from "./packages.json";

const sourceConfig = v.parse(sourceDependencyConfigSchema, config);
const packages = validateMiraSkillPackages(bundle);
for (const [id, source] of Object.entries(sourceConfig.skills)) {
    const entry = packages.find((item) => item.id === id);
    if (
        !entry ||
        entry.version !== source.version ||
        entry.revision !== source.revision ||
        entry.entrypoint !== source.entrypoint ||
        new Bun.CryptoHasher("sha256")
            .update(skillSourceText(entry.files))
            .digest("hex") !== source.contentHash
    )
        throw new Error(
            "Bundled skill sources do not match package.json. Run bun run skills:sync."
        );
    const base = `https://github.com/${source.update.repository}`;
    entry.sources = [
        `${base}/tree/${source.revision}`,
        ...source.paths.map((file) => `${base}/blob/${source.revision}/${file}`),
    ];
}
const digest = (value: string) =>
    new Bun.CryptoHasher("sha256").update(value).digest("hex");
const summaries: Omit<MiraSkillSummary, "control" | "compatibility">[] = packages.map(
    ({ files, ...entry }) => {
        const ordered = Object.entries(files).toSorted(([left], [right]) =>
            left.localeCompare(right)
        );
        return {
            ...entry,
            packageHash: digest(JSON.stringify([entry, ordered])),
            files: ordered.map(([path, content]) => ({
                path,
                sha256: digest(content),
                bytes: Buffer.byteLength(content, "utf8"),
            })),
        };
    }
);

/**
 * Describe installed sources and integration notes without including upstream file bodies.
 * @returns Fresh metadata and fingerprints, computed once for the immutable release.
 */
export function describeMiraSkillPackages(): Omit<
    MiraSkillSummary,
    "control" | "compatibility"
>[] {
    return summaries.map((entry) => ({
        ...entry,
        sources: [...entry.sources],
        tools: [...entry.tools],
        controls: [...entry.controls],
        files: entry.files.map((file) => ({ ...file })),
    }));
}

/**
 * Read a bounded segment of a manifest-listed original source file without executing it.
 * @param id - Supported package identifier.
 * @param file - Exact manifest key, or the package's original SKILL.md entrypoint.
 * @param offset - UTF-16 character offset returned by the previous segment.
 * @returns Versioned source with the full-file hash and next offset, or null for a missing file.
 */
export function readBundledMiraSkill(
    id: MiraSkillId,
    file?: string,
    offset = 0
): MiraSkillDocument | null {
    const entry = packages.find((item) => item.id === id);
    if (!entry) return null;
    const key = file ?? entry.entrypoint;
    if (!Object.hasOwn(entry.files, key)) return null;
    const source = entry.files[key]!;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length)
        throw new Error("Invalid skill file offset.");
    let end = Math.min(offset + 24_000, source.length);
    if (end < source.length && source.codePointAt(end - 1)! > 0xff_ff) end--;
    const summary = summaries.find((item) => item.id === id)!;
    return {
        id,
        version: entry.version,
        packageHash: summary.packageHash,
        path: key,
        sha256: summary.files.find((item) => item.path === key)!.sha256,
        content: source.slice(offset, end),
        offset,
        nextOffset: end < source.length ? end : null,
        totalCharacters: source.length,
        integration: entry.integration,
    };
}

/** Digest of complete compiled sources and separate integration notes for executor compatibility. */
export const miraSkillCatalogHash = digest(
    JSON.stringify(summaries.map((entry) => [entry.id, entry.packageHash]))
);

/**
 * Return complete release-owned skill packages for native installation.
 * @returns Native-compatible packages with upstream pins already verified; callers must not mutate them.
 */
export function bundledNativeMiraSkills() {
    return packages;
}
