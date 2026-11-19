import * as v from "valibot";

export const browserClipboardTimeoutMs = 15_000;

export const browserClipboardTextSchema = v.pipe(v.string(), v.maxLength(8192));
export const browserClipboardCommandSchema = v.variant("kind", [
    v.strictObject({ kind: v.literal("copy") }),
    v.strictObject({ kind: v.literal("read") }),
    v.strictObject({ kind: v.literal("paste"), text: browserClipboardTextSchema }),
]);
export const browserClipboardResultSchema = v.variant("ok", [
    v.strictObject({ ok: v.literal(true), text: browserClipboardTextSchema }),
    v.strictObject({ ok: v.literal(false) }),
]);
