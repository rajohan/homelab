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
] as const;

export const miraSkillIdSchema = v.picklist(miraSkillIds);
export type MiraSkillId = v.InferOutput<typeof miraSkillIdSchema>;

export const miraSkillReadSchema = v.strictObject({
    id: miraSkillIdSchema,
    packageHash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    file: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(160)), "SKILL.md"),
});

export interface MiraSkillSummary {
    id: MiraSkillId;
    title: string;
    description: string;
    version: string;
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
}
