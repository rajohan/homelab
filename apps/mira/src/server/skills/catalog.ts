import {
    miraSkillIdSchema,
    miraSkillIds,
    type MiraSkillDocument,
    type MiraSkillId,
    type MiraSkillSummary,
} from "@homelab/contracts/miraSkills";
import * as v from "valibot";

import bundle from "./packages.json";

const text = (maximum: number) =>
    v.pipe(v.string(), v.minLength(1), v.maxLength(maximum));
const fileSchema = v.pipe(
    text(160),
    v.regex(/^(?:[a-z0-9-]+\/)*[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/)
);
const packageSchema = v.strictObject({
    id: miraSkillIdSchema,
    title: text(80),
    description: text(300),
    version: v.pipe(text(40), v.regex(/^\d+\.\d+\.\d+$/)),
    repositoryContext: v.boolean(),
    sources: v.pipe(
        v.array(v.pipe(text(500), v.url(), v.startsWith("https://"))),
        v.minLength(1),
        v.maxLength(8)
    ),
    tools: v.pipe(v.array(v.pipe(text(100), v.regex(/^mira_[a-z_]+$/))), v.maxLength(30)),
    controls: v.pipe(
        v.array(v.pipe(text(100), v.regex(/^integration:[a-z-]+$/))),
        v.maxLength(8)
    ),
    files: v.pipe(
        v.record(
            fileSchema,
            v.pipe(
                text(48_000),
                v.check((value) => Buffer.byteLength(value, "utf8") <= 48_000)
            )
        ),
        v.check(
            (files) => Object.hasOwn(files, "SKILL.md") && Object.keys(files).length <= 8
        )
    ),
});

/**
 * Validate the complete bundled guidance without discovering or executing host files.
 * @param input - Release-owned package data; never a model or downloaded installer.
 * @returns Bounded packages with one entry for every supported skill identifier.
 */
export function validateMiraSkillPackages(input: unknown) {
    return v.parse(
        v.pipe(
            v.array(packageSchema),
            v.length(miraSkillIds.length),
            v.check(
                (entries) =>
                    new Set(entries.map((entry) => entry.id)).size === entries.length
            ),
            v.check(
                (entries) =>
                    entries.reduce(
                        (total, entry) =>
                            total +
                            Object.values(entry.files).reduce(
                                (bytes, content) =>
                                    bytes + Buffer.byteLength(content, "utf8"),
                                0
                            ),
                        0
                    ) <= 262_144
            )
        ),
        input
    );
}

const packages = validateMiraSkillPackages(bundle);
const digest = (value: string) =>
    new Bun.CryptoHasher("sha256").update(value).digest("hex");

/**
 * Describe the installed release's guidance without including its instruction bodies.
 * @returns Fresh metadata objects, file hashes and a digest of each complete package.
 */
export function describeMiraSkillPackages(): Omit<
    MiraSkillSummary,
    "control" | "compatibility"
>[] {
    return packages.map(({ files, ...entry }) => {
        const ordered = Object.entries(files).toSorted(([left], [right]) =>
            left.localeCompare(right)
        );
        return {
            ...entry,
            sources: [...entry.sources],
            tools: [...entry.tools],
            controls: [...entry.controls],
            packageHash: digest(JSON.stringify([entry, ordered])),
            files: ordered.map(([path, content]) => ({
                path,
                sha256: digest(content),
                bytes: Buffer.byteLength(content, "utf8"),
            })),
        };
    });
}

/**
 * Read only a manifest-listed passive Markdown file from the compiled bundle.
 * @param id - Supported package identifier.
 * @param file - Exact manifest key; no filesystem or network resolution is performed.
 * @returns The versioned document, or null for an absent package/file.
 */
export function readBundledMiraSkill(
    id: MiraSkillId,
    file: string
): MiraSkillDocument | null {
    const entry = packages.find((item) => item.id === id);
    if (!entry || !Object.hasOwn(entry.files, file)) return null;
    const summary = describeMiraSkillPackages().find((item) => item.id === id)!;
    const content = entry.files[file]!;
    return {
        id,
        version: entry.version,
        packageHash: summary.packageHash,
        path: file,
        sha256: digest(content),
        content,
    };
}

/** Digest of the complete compiled guidance exposed by this executor release. */
export const miraSkillCatalogHash = digest(
    JSON.stringify(
        describeMiraSkillPackages().map((entry) => [entry.id, entry.packageHash])
    )
);
