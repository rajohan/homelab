import * as v from "valibot";

const key = "homelab:mira:chat-display:v2";
const schema = v.strictObject({
    showThinking: v.boolean(),
    showTools: v.boolean(),
    expandTools: v.boolean(),
});
export type ChatDisplaySettings = v.InferOutput<typeof schema>;
const defaults: ChatDisplaySettings = {
    showThinking: true,
    showTools: true,
    expandTools: false,
};

/**
 * Read presentation preferences, falling back when browser storage is absent or invalid.
 * @returns Local display settings; no conversation content is stored here.
 */
export function readChatDisplay(): ChatDisplaySettings {
    try {
        const parsed = v.safeParse(
            schema,
            JSON.parse(globalThis.localStorage.getItem(key) ?? "null")
        );
        if (parsed.success) return parsed.output;
        const legacy = v.safeParse(v.object({ showTools: v.boolean(), expandTools: v.boolean() }), JSON.parse(globalThis.localStorage.getItem("homelab:mira:chat-display:v1") ?? "null"));
        return legacy.success ? { ...defaults, ...legacy.output } : defaults;
    } catch {
        return defaults;
    }
}

/**
 * Remember only the operator's display switches in this browser.
 * @param settings - Validated local preferences; unavailable storage does not block chat.
 */
export function saveChatDisplay(settings: ChatDisplaySettings): void {
    try {
        globalThis.localStorage.setItem(key, JSON.stringify(v.parse(schema, settings)));
    } catch {
        /* Browser privacy settings may disable persistence. */
    }
}
