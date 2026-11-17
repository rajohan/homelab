import {
    miraSkillFileSchema,
    miraSkillIds,
    miraSkillIdSchema,
} from "@homelab/contracts/miraSkills";
import * as v from "valibot";

const encoder = new TextEncoder();
const text = (maximum: number) =>
    v.pipe(v.string(), v.minLength(1), v.maxLength(maximum));

export const miraSkillPackageSchema = v.strictObject({
    id: miraSkillIdSchema,
    title: text(80),
    description: text(300),
    version: v.pipe(text(40), v.regex(/^\d+\.\d+\.\d+$/)),
    revision: v.optional(v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/))),
    entrypoint: v.optional(miraSkillFileSchema, "SKILL.md"),
    integration: v.optional(text(3000)),
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
            miraSkillFileSchema,
            v.pipe(
                text(2_097_152),
                v.check((value) => encoder.encode(value).byteLength <= 2_097_152)
            )
        ),
        v.check(
            (files) => Object.keys(files).length > 0 && Object.keys(files).length <= 256
        )
    ),
});

/**
 * Validate complete release-owned skill sources without loading or executing host files.
 * @param input - Compiled package data, including verbatim upstream text and separate integration notes.
 * @returns Bounded packages with unique identifiers and existing Markdown entrypoints.
 */
export function validateMiraSkillPackages(input: unknown) {
    return v.parse(
        v.pipe(
            v.array(miraSkillPackageSchema),
            v.length(miraSkillIds.length),
            v.check(
                (entries) =>
                    new Set(entries.map((entry) => entry.id)).size === entries.length
            ),
            v.check((entries) =>
                entries.every((entry) =>
                    entry.entrypoint.endsWith("/SKILL.md") ||
                    entry.entrypoint === "SKILL.md"
                        ? Object.hasOwn(entry.files, entry.entrypoint)
                        : false
                )
            ),
            v.check(
                (entries) =>
                    entries.reduce(
                        (total, entry) =>
                            total +
                            Object.values(entry.files).reduce(
                                (bytes, content) =>
                                    bytes + encoder.encode(content).byteLength,
                                0
                            ),
                        0
                    ) <= 8_388_608
            )
        ),
        input
    );
}

/**
 * Fingerprint original file paths and exact UTF-8 contents in deterministic order.
 * @param files - Complete source selection with no rewritten or shortened documents.
 * @returns Canonical serialization of the ordered path/content pairs, shared by synchronization and runtime validation.
 */
export function skillSourceText(files: Record<string, string>): string {
    const ordered = Object.keys(files)
        .toSorted()
        .map((file) => [file, files[file]]);
    return JSON.stringify(ordered);
}
