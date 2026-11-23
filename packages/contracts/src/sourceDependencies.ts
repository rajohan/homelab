import * as v from "valibot";

import { miraSkillFileSchema } from "./miraSkills";

export const sourceVersionSchema = v.pipe(
    v.string(),
    v.regex(/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:\.\d{1,9})?$/)
);
const reviewedUpdateSchema = v.strictObject({
    dependency: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    pinned: sourceVersionSchema,
    available: sourceVersionSchema,
});
export const prepareSourceUpdatesSchema = v.union([
    reviewedUpdateSchema,
    v.strictObject({ all: v.pipe(v.array(reviewedUpdateSchema), v.minLength(1)) }),
]);
export type PrepareSourceUpdates = v.InferOutput<typeof prepareSourceUpdatesSchema>;
export type AvailableSourceUpdate = v.InferOutput<typeof reviewedUpdateSchema> & {
    name: string;
};

/** Collect updates confirmed by the upstream checks.
 * @param items - Dependency observations from the current manifest.
 * @returns Available updates with their installed and proposed versions.
 */
export function availableSourceUpdates(
    items: readonly {
        id: string;
        name: string;
        status: string;
        pinned: string;
        available: string | null;
    }[]
): AvailableSourceUpdate[] {
    return items.flatMap((item) =>
        item.status === "available" && item.available
            ? [
                  {
                      dependency: item.id,
                      name: item.name,
                      pinned: item.pinned,
                      available: item.available,
                  },
              ]
            : []
    );
}

/** Match a reviewed single update or complete batch against the current offered updates.
 * @param input - Versions displayed at confirmation.
 * @param available - Fresh updates in the operator's current source inventory.
 * @returns Server-observed rows, or null if the selection is incomplete or changed.
 */
export function matchSourceUpdates(
    input: PrepareSourceUpdates,
    available: readonly AvailableSourceUpdate[]
) {
    const expected = "all" in input ? input.all : [input];
    if ("all" in input && expected.length !== available.length) return null;
    const reviewed = new Map(expected.map((row) => [row.dependency, row]));
    const matching = available.filter((row) => {
        const before = reviewed.get(row.dependency);
        return before?.pinned === row.pinned && before.available === row.available;
    });
    return matching.length === expected.length ? matching : null;
}
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
