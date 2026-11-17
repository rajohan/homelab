// Built-in Realtime voices from the supported OpenAI session schema.
export const miraVoiceNames = [
    "marin",
    "cedar",
    "alloy",
    "ash",
    "ballad",
    "coral",
    "echo",
    "sage",
    "shimmer",
    "verse",
] as const;
export type MiraVoiceName = (typeof miraVoiceNames)[number];
