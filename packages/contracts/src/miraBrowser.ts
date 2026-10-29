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
