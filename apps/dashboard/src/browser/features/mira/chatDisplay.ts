import * as v from "valibot";

const key = "homelab:mira:chat-display:v1";
const schema = v.strictObject({
    showActivity: v.boolean(),
    keepActivity: v.boolean(),
    showTools: v.boolean(),
    expandTools: v.boolean(),
});
export type ChatDisplaySettings = v.InferOutput<typeof schema>;
const defaults: ChatDisplaySettings = {
    showActivity: true,
    keepActivity: false,
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
        return parsed.success ? parsed.output : defaults;
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
