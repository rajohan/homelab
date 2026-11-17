import * as v from "valibot";

export const miraChatgptStatusSchema = v.object({
    state: v.picklist(["connected", "disconnected", "expired", "error"]),
    checkedAt: v.string(),
});
export type MiraChatgptStatus = v.InferOutput<typeof miraChatgptStatusSchema>;

/** Explain provider health without exposing upstream errors or stored credentials.
 * @param state - Last verified connection outcome.
 * @returns Actionable text for dashboard status and waiting messages.
 */
export function chatgptStatusMessage(state: MiraChatgptStatus["state"]): string {
    const messages: Record<MiraChatgptStatus["state"], string> = {
        connected: "ChatGPT connected. Sign-in verified.",
        expired:
            "ChatGPT sign-in has expired. Sign in again to continue waiting messages automatically.",
        disconnected:
            "ChatGPT is not signed in. Sign in to continue waiting messages automatically.",
        error: "ChatGPT connection failed. Retrying automatically; waiting messages are saved.",
    };
    return messages[state];
}
