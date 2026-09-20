import * as v from "valibot";

const text = (maximum: number) =>
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maximum));
export const updateItemSchema = v.strictObject({
    id: text(200),
    name: text(200),
    kind: v.picklist(["os", "runtime", "application", "container"]),
    installed: text(200),
    available: v.nullable(text(200)),
    status: v.picklist(["current", "available", "unknown"]),
    security: v.optional(v.boolean(), false),
    held: v.optional(v.boolean(), false),
    release: v.optional(v.picklist(["bun", "node", "openclaw", "github-cli"])),
    image: v.optional(text(300)),
    platform: v.optional(
        v.strictObject({
            os: text(32),
            architecture: text(32),
            variant: v.optional(text(32)),
        })
    ),
});
export const updateReportSchema = v.strictObject({
    capturedAt: v.pipe(v.string(), v.isoTimestamp()),
    repositoryMetadataAt: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
    complete: v.boolean(),
    coveredKinds: v.pipe(
        v.array(v.picklist(["os", "runtime", "application", "container"])),
        v.minLength(1),
        v.maxLength(4)
    ),
    items: v.pipe(v.array(updateItemSchema), v.maxLength(5000)),
});
export type UpdateItem = v.InferOutput<typeof updateItemSchema>;
export type UpdateReport = v.InferOutput<typeof updateReportSchema>;
export const updateListSchema = v.strictObject({
    source: text(100),
    search: v.optional(v.pipe(v.string(), v.maxLength(160)), ""),
    state: v.optional(v.picklist(["attention", "all"]), "attention"),
    after: v.optional(text(200)),
    limit: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
        50
    ),
});
export interface UpdateSource {
    readonly id: string;
    readonly label: string;
    readonly publisher: string;
}
export interface UpdateSourceStatus {
    readonly id: string;
    readonly label: string;
    readonly stale: boolean;
    readonly report:
        | (Omit<UpdateReport, "items"> & {
              readonly available: number;
              readonly security: number;
              readonly total: number;
          })
        | null;
}
