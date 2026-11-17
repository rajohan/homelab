import { miraVoiceNames } from "@homelab/contracts/miraVoice";
import { ErrorNotice, IconButton, Select } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useSyncExternalStore } from "react";

import { api } from "../../api/client";
import type { MiraVoiceConnection } from "./voiceConnection";

/** Configure the shared audio transport from Chat settings.
 * @returns Voice model, speaking voice and an explicit preview; changes apply immediately.
 */
export function VoiceSettings({ voice }: { readonly voice: MiraVoiceConnection }) {
    const state = useSyncExternalStore(voice.subscribe, voice.snapshot);
    const catalog = useQuery({
        queryKey: ["operations", "mira", "voice-models"],
        queryFn: () => api.mira.voice.models.query(),
        staleTime: 60_000,
    });
    const models = catalog.data?.models ?? [];
    const available = catalog.data?.configured === true && models.includes(state.model);
    return (
        <div className="space-y-3 border-t border-primary-700 pt-4">
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
            <Select
                label="Speaking voice"
                value={state.voice}
                onChange={(name) => voice.speakingVoice(name)}
                options={miraVoiceNames.map((name) => ({
                    value: name,
                    label: name[0]!.toUpperCase() + name.slice(1),
                }))}
            />
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
            {catalog.error && <ErrorNotice error={catalog.error} />}
            {catalog.data?.configured === false && (
                <p className="text-sm text-primary-300">Voice is not configured.</p>
            )}
        </div>
    );
}
