import * as v from "valibot";

import { applicationHostSchema } from "./applications";

const nanoseconds = v.pipe(v.string(), v.regex(/^[0-9]{19}$/));
export const applicationLogsSchema = v.strictObject({
    host: applicationHostSchema,
    container: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    range: v.optional(v.picklist(["15m", "1h", "6h", "24h", "7d"]), "24h"),
    search: v.optional(v.pipe(v.string(), v.maxLength(160)), ""),
    cursor: v.optional(v.strictObject({ since: nanoseconds, before: nanoseconds })),
});
export type LogCursor = v.InferOutput<typeof applicationLogsSchema>["cursor"];
export interface LogEntry {
    readonly id: string;
    readonly timestamp: string;
    readonly message: string;
    readonly level: string;
}
export interface LogPage {
    readonly entries: readonly LogEntry[];
    readonly nextCursor: LogCursor | null;
}
