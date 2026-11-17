import * as v from "valibot";

import type { MiraSwitch } from "./mira";

export const miraSkillIds = [
    "task-tracking",
    "agentmail",
    "daytona",
    "github",
    "here-now",
    "moltbook",
    "frontend-improvement",
    "impeccable",
    "intent",
] as const;

export const miraSkillIdSchema = v.picklist(miraSkillIds);
export type MiraSkillId = v.InferOutput<typeof miraSkillIdSchema>;

export const miraSkillFileSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(200),
    v.regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/),
    v.check((file) => file.split("/").every((part) => part !== "." && part !== ".."))
);

export const miraSkillReadSchema = v.strictObject({
    id: miraSkillIdSchema,
    packageHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    file: v.optional(miraSkillFileSchema),
    offset: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2_097_152)),
        0
    ),
});

export interface MiraSkillSummary {
    id: MiraSkillId;
    title: string;
    description: string;
    version: string;
    revision?: string | undefined;
    entrypoint: string;
    integration?: string | undefined;
    packageHash: string;
    sources: string[];
    tools: string[];
    controls: string[];
    repositoryContext: boolean;
    compatibility: "available" | "offline" | "update_required";
    files: { path: string; sha256: string; bytes: number }[];
    control: MiraSwitch;
}

export interface MiraSkillDocument {
    id: MiraSkillId;
    version: string;
    packageHash: string;
    path: string;
    sha256: string;
    content: string;
    offset: number;
    nextOffset: number | null;
    totalCharacters: number;
    integration?: string | undefined;
}
