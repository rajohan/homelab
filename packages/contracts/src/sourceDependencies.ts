import * as v from "valibot";

import { miraSkillFileSchema } from "./miraSkills";

export const sourceVersionSchema = v.pipe(
    v.string(),
    v.regex(/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:\.\d{1,9})?$/)
);
export const sourceUpdateSchema = v.variant("kind", [
    v.object({
        kind: v.literal("github"),
        repository: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
        tagPrefix: v.pipe(v.string(), v.maxLength(40), v.regex(/^[A-Za-z0-9_-]*$/)),
        separator: v.optional(v.picklist([".", "_"]), "."),
    }),
    v.object({
        kind: v.literal("nuget"),
        package: v.pipe(v.string(), v.regex(/^[a-z0-9.-]+$/)),
    }),
]);
const sourceDependencySchema = v.object({
    version: sourceVersionSchema,
    update: sourceUpdateSchema,
});
const sourcePathSchema = v.pipe(
    v.string(),
    v.regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.md$/)
);
export const sourceDependencyConfigSchema = v.object({
    windows: v.record(v.string(), sourceDependencySchema),
    skills: v.record(
        v.string(),
        v.object({
            ...sourceDependencySchema.entries,
            update: sourceUpdateSchema.options[0],
            revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{40}$/)),
            paths: v.pipe(v.array(sourcePathSchema), v.maxLength(7)),
            include: v.pipe(
                v.array(miraSkillFileSchema),
                v.minLength(1),
                v.maxLength(12)
            ),
            entrypoint: miraSkillFileSchema,
            contentHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
        })
    ),
});
