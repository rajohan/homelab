import { IconButton } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import {
    LoaderCircle,
    Mic,
    MicOff,
    Pause,
    Play,
    Square,
    Volume2,
    VolumeX,
} from "lucide-react";
import { useSyncExternalStore } from "react";

import { api } from "../../api/client";
import type { MiraVoiceConnection } from "./voiceConnection";

/** Keep independent microphone and playback actions inside the composer.
 * @returns Compact controls with accessible capture and connection state.
 */
export function MiraVoice({ voice }: { readonly voice: MiraVoiceConnection }) {
    const state = useSyncExternalStore(voice.subscribe, voice.snapshot);
    const catalog = useQuery({
        queryKey: ["operations", "mira", "voice-models"],
        queryFn: () => api.mira.voice.models.query(),
        staleTime: 60_000,
        refetchInterval: 300_000,
    });
    const available =
        catalog.data?.configured === true && catalog.data.models.includes(state.model);
    const connecting =
        state.microphone && ["connecting", "reconnecting"].includes(state.connection);
    const microphoneIcon = state.microphone ? Mic : MicOff;
    let microphone = "Turn microphone on";
    if (state.microphone) microphone = "Turn microphone off";
    if (connecting) microphone = "Microphone connecting — turn off";
    if (state.paused) microphone = "Microphone paused — turn off";
    return (
        <>
            <IconButton
                icon={connecting ? LoaderCircle : microphoneIcon}
                label={microphone}
                disabled={!state.microphone && !available}
                aria-pressed={state.microphone}
                className={state.microphone && !state.paused ? "text-red-300" : ""}
                onClick={() => void voice.microphone(!state.microphone)}
            />
            {state.microphone && (
                <IconButton
                    icon={state.paused ? Play : Pause}
                    label={state.paused ? "Resume microphone" : "Pause microphone"}
                    onClick={() => void voice.pause(!state.paused)}
                />
            )}
            <IconButton
                icon={state.speech ? Volume2 : VolumeX}
                label={
                    state.speech ? "Turn spoken replies off" : "Turn spoken replies on"
                }
                aria-pressed={state.speech}
                disabled={!state.speech && !available}
                onClick={() => voice.speech(!state.speech)}
            />
            {state.speaking && (
                <IconButton
                    icon={Square}
                    label="Stop reading"
                    onClick={() => voice.stopSpeaking()}
                />
            )}
        </>
    );
}
