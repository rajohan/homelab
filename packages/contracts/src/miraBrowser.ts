import * as v from "valibot";

const id = v.pipe(v.string(), v.uuid());
const address = v.pipe(v.string(), v.minLength(1), v.maxLength(2048));
export const miraBrowserAccessRequestSchema = v.strictObject({
    runId: id,
    origins: v.pipe(v.array(address), v.minLength(1), v.maxLength(16)),
    initialUrl: address,
    mode: v.picklist(["view", "control"]),
});
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
export const miraBrowserHumanCommandSchema = v.strictObject({
    id,
    epoch: id,
    commandId: id,
    operation: v.variant("method", [
        v.strictObject({ method: v.literal("observe") }),
        v.strictObject({ method: v.literal("navigate"), url: address }),
        v.strictObject({ method: v.literal("act"), input: miraBrowserActionSchema }),
    ]),
});
export interface MiraBrowserPreview {
    observationId: string;
    url: string;
    title: string;
    refs: { ref: string; role: string; label: string; actions: ("click" | "type")[] }[];
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
