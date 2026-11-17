import type { MiraMessage } from "@homelab/contracts/mira";
import { miraVoiceNames } from "@homelab/contracts/miraVoice";
import { Button, IconButton, Select } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Mic, MicOff, Pause, Play, Square, Volume2, VolumeX } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { api } from "../../api/client";
import type { MiraVoiceConnection } from "./voiceConnection";

/** Independent microphone and playback controls for the selected Mira conversation.
 * @returns Shared desktop/mobile controls with visible capture and transport status.
 */
export function MiraVoice({
    voice,
    messages,
}: {
    readonly voice: MiraVoiceConnection;
    readonly messages: readonly MiraMessage[];
}) {
    const state = useSyncExternalStore(voice.subscribe, voice.snapshot);
    const catalog = useQuery({
        queryKey: ["operations", "mira", "voice-models"],
        queryFn: () => api.mira.voice.models.query(),
        staleTime: 60_000,
        refetchInterval: 300_000,
    });
    useEffect(() => {
        voice.messages(messages);
    }, [voice, messages]);
    const available =
        catalog.data?.configured === true && catalog.data.models.includes(state.model);
    const models = catalog.data?.models ?? [];
    let microphone = "Microphone off";
    if (state.microphone) microphone = "Microphone waiting for connection";
    if (state.microphone && state.connection === "connected") microphone = "Listening";
    if (state.microphone && state.paused) microphone = "Microphone paused";
    return (
        <section
            aria-label="Mira voice"
            className="border-t border-primary-700 px-3 py-2 sm:px-4"
        >
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={!state.microphone && !available}
                    aria-pressed={state.microphone}
                    className={
                        state.microphone && !state.paused
                            ? "border-red-700 text-red-300"
                            : ""
                    }
                    onClick={() => void voice.microphone(!state.microphone)}
                >
                    {state.microphone ? (
                        <Mic size={16} aria-hidden="true" />
                    ) : (
                        <MicOff size={16} aria-hidden="true" />
                    )}
                    {microphone}
                </Button>
                <IconButton
                    icon={state.paused ? Play : Pause}
                    label={state.paused ? "Resume microphone" : "Pause microphone"}
                    disabled={!state.microphone}
                    onClick={() => void voice.pause(!state.paused)}
                />
                <IconButton
                    icon={state.speech ? Volume2 : VolumeX}
                    label={
                        state.speech
                            ? "Turn spoken replies off"
                            : "Turn spoken replies on"
                    }
                    aria-pressed={state.speech}
                    disabled={!state.speech && !available}
                    onClick={() => voice.speech(!state.speech)}
                />
                {state.speaking && (
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => voice.stopSpeaking()}
                    >
                        <Square size={16} aria-hidden="true" />
                        Stop reading
                    </Button>
                )}
                <div className="ml-auto min-w-48">
                    <Select
                        label="Voice model"
                        value={state.model}
                        onChange={(model) => voice.model(model)}
                        disabled={!catalog.data?.configured}
                        options={[
                            ...models.map((model) => ({ value: model, label: model })),
                            ...(models.includes(state.model)
                                ? []
                                : [
                                      {
                                          value: state.model,
                                          label: `${state.model} (unavailable)`,
                                      },
                                  ]),
                        ]}
                    />
                </div>
                <div className="min-w-32">
                    <Select
                        label="Speaking voice"
                        value={state.voice}
                        onChange={(name) => voice.speakingVoice(name)}
                        options={miraVoiceNames.map((name) => ({
                            value: name,
                            label: name[0]!.toUpperCase() + name.slice(1),
                        }))}
                    />
                </div>
                <IconButton
                    icon={Play}
                    label="Preview voice"
                    disabled={!available}
                    onClick={() =>
                        voice.read({
                            id: "voice-preview",
                            role: "assistant",
                            content: "Hello. This is Mira's selected voice.",
                            state: "completed",
                            attachmentIds: [],
                            createdAt: new Date().toISOString(),
                        })
                    }
                />
            </div>
            <output className="mt-1 block text-xs text-primary-400">
                {microphone} · Spoken replies {state.speech ? "on" : "off"}
                {state.connection !== "off" && ` · ${state.connection}`}. Voice uses the
                OpenAI API; your selected chat model does the work.
            </output>
            {state.transcript && (
                <p
                    className="mt-2 text-sm wrap-anywhere text-primary-200"
                    aria-label="Voice transcript"
                    aria-live="polite"
                >
                    {state.transcript}
                </p>
            )}
            {(state.error || catalog.error || catalog.data?.configured === false) && (
                <p role="alert" className="mt-2 text-sm text-red-300">
                    {state.error ||
                        catalog.error?.message ||
                        "Voice needs HOMELAB_MIRA_OPENAI_API_KEY in Doppler."}
                </p>
            )}
            {(state.error || state.pending > 0) && (
                <div className="mt-2 flex items-center gap-2">
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                            void catalog.refetch();
                            voice.retry();
                        }}
                    >
                        Retry
                    </Button>
                    {state.pending > 0 && (
                        <>
                            <span className="text-xs text-primary-300">
                                {state.pending} transcript(s) waiting to send
                            </span>
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => voice.discardPending()}
                            >
                                Discard unsent
                            </Button>
                        </>
                    )}
                </div>
            )}
        </section>
    );
}
