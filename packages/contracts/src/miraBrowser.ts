import * as v from "valibot";

const id = v.pipe(v.string(), v.uuid());
const address = v.pipe(v.string(), v.minLength(1), v.maxLength(2048));
export const miraBrowserAccessRequestSchema = v.strictObject({
    runId: id,
    origins: v.pipe(v.array(address), v.minLength(1), v.maxLength(16)),
    initialUrl: address,
    mode: v.picklist(["view", "control"]),
    profileId: v.optional(id),
});
export const miraBrowserProfileCreateSchema = v.strictObject({
    name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
    origins: v.pipe(v.array(address), v.minLength(1), v.maxLength(16)),
});
export const miraBrowserProfileDeleteSchema = v.strictObject({ id });
export interface MiraBrowserProfile {
    id: string;
    name: string;
    origins: string[];
    state: "active" | "deleting";
    busy: boolean;
    createdAt: string;
}
export const miraBrowserAccessStopSchema = v.strictObject({ id });
export const miraBrowserAccessListSchema = v.optional(v.strictObject({ runId: id }));
export interface MiraBrowserAccessSummary {
    id: string;
    runId: string;
    mode: "view" | "control";
    state: "pending" | "active" | "stopping" | "closed" | "unavailable";
    expiresAt: string;
    origins: string[];
    initialUrl: string | null;
}

const ref = v.pipe(v.string(), v.regex(/^p[0-9]{1,16}:[0-9]{1,6}$/));
export const miraBrowserActionSchema = v.variant("action", [
    v.strictObject({ action: v.literal("click"), observationId: id, ref }),
    v.strictObject({
        action: v.literal("type"),
        observationId: id,
        ref,
        text: v.pipe(
            v.string(),
            v.maxLength(4000),
            v.check((text) => text.isWellFormed() && !text.includes("\0"))
        ),
        replace: v.boolean(),
    }),
]);
export const miraBrowserConsoleSchema = v.strictObject({ id });
export const miraBrowserTransferSchema = v.strictObject({
    id,
    epoch: id,
    controller: v.picklist(["mira", "human"]),
});
export const miraBrowserUploadFileSchema = v.strictObject({
    id,
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    size: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(25 * 1024 * 1024)),
    sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
export type MiraBrowserUploadFile = v.InferOutput<typeof miraBrowserUploadFileSchema>;
export const miraBrowserHumanOperationSchema = v.variant("method", [
    v.strictObject({ method: v.literal("observe") }),
    v.strictObject({ method: v.literal("navigate"), url: address }),
    v.strictObject({ method: v.literal("act"), input: miraBrowserActionSchema }),
    v.strictObject({
        method: v.literal("upload"),
        input: v.strictObject({ observationId: id, ref }),
        origin: address,
        file: miraBrowserUploadFileSchema,
    }),
]);
export const miraBrowserHumanCommandSchema = v.strictObject({
    id,
    epoch: id,
    commandId: id,
    operation: miraBrowserHumanOperationSchema,
});
export interface MiraBrowserPreview {
    observationId: string;
    url: string;
    title: string;
    refs: {
        ref: string;
        role: string;
        label: string;
        actions: ("click" | "type" | "upload")[];
    }[];
    width: number;
    height: number;
    image: string;
    observedAt: string;
}
export interface MiraBrowserConsole {
    epoch: string;
    controller: "mira" | "human";
    busy: boolean;
    preview: MiraBrowserPreview | null;
}
