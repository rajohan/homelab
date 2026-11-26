import type { MiraChatSettings, MiraModel } from "@homelab/contracts/mira";
import {
    ActionGroup,
    ActivityPanel,
    Button,
    ErrorNotice,
    Modal,
    Switch,
} from "@homelab/ui";
import { Cpu } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import type { ChatDisplaySettings } from "./chatDisplay";
import { CodeTargetSettings } from "./CodeTargetSettings";
import { ModelSettings } from "./ModelSettings";
import { RecallSettings } from "./RecallSettings";
import type { MiraVoiceConnection } from "./voiceConnection";
import { VoiceSettings } from "./VoiceSettings";

/**
 * Edit conversation preferences using the runtime's advertised model capabilities.
 * @returns The quick model form for the header popover or the complete chat settings dialog.
 */
export function ChatSettings({
    destination,
    settings,
    models,
    defaultModel,
    fresh,
    onClose,
    ...options
}: {
    readonly destination:
        | { id: string; version: number }
        | { saveDraft: (settings: MiraChatSettings) => void };
    readonly settings: MiraChatSettings;
    readonly models: MiraModel[];
    readonly defaultModel: string | null;
    readonly fresh: boolean;
    readonly onClose: () => void;
} & (
    | { readonly modelOnly: true }
    | {
          readonly modelOnly?: false;
          readonly voice: MiraVoiceConnection;
          readonly display: ChatDisplaySettings;
          readonly onDisplayChange: (display: ChatDisplaySettings) => void;
      }
)) {
    const [original] = useState({ settings, destination });
    const [draft, setDraft] = useState(settings);
    const modelChanged =
        draft.model !== original.settings.model ||
        draft.effort !== original.settings.effort ||
        draft.serviceTier !== original.settings.serviceTier;
    const selectedId =
        draft.model ?? defaultModel ?? models.find((model) => model.isDefault)?.model;
    const selected = models.find((model) => model.model === selectedId);
    const supported =
        selected &&
        (!draft.effort ||
            selected.supportedReasoningEfforts.some(
                (entry) => entry.reasoningEffort === draft.effort
            )) &&
        (!draft.serviceTier ||
            selected.serviceTiers.some((entry) => entry.id === draft.serviceTier));
    const canSave =
        (!options.modelOnly || modelChanged) && (!modelChanged || (fresh && supported));
    const save = useOperation((target: { id: string; version: number }, signal) =>
        api.mira.conversations.settings.mutate({ ...target, settings: draft }, { signal })
    );
    const form = (
        <form
            className="grid grid-cols-1 gap-4"
            onSubmit={(event) => {
                event.preventDefault();
                if (!canSave || save.isPending) return;
                if ("saveDraft" in original.destination) {
                    original.destination.saveDraft(draft);
                    onClose();
                    return;
                }
                void save
                    .mutateAsync(original.destination)
                    .then(onClose)
                    .catch(() => {});
            }}
        >
            {!fresh && (
                <p className="text-sm text-primary-300">
                    {options.modelOnly
                        ? "Reconnect Mira to change model choices."
                        : "Reconnect Mira to change model choices. Other settings remain available."}
                </p>
            )}
            <ModelSettings
                draft={draft}
                setDraft={setDraft}
                models={models}
                defaultModel={defaultModel}
                fresh={fresh}
                disabled={save.isPending}
            />
            {!options.modelOnly && (
                <>
                    <VoiceSettings voice={options.voice} />
                    <CodeTargetSettings
                        value={draft.executionTarget}
                        disabled={save.isPending}
                        onChange={(executionTarget) =>
                            setDraft({ ...draft, executionTarget })
                        }
                    />
                    <RecallSettings
                        hideLegend
                        settings={draft}
                        onChange={setDraft}
                        disabled={save.isPending}
                    />
                    <div className="space-y-3">
                        <Switch
                            label="Show work notes"
                            checked={options.display.showThinking}
                            onChange={(showThinking) =>
                                options.onDisplayChange({
                                    ...options.display,
                                    showThinking,
                                })
                            }
                        />
                        <Switch
                            label="Show tools"
                            checked={options.display.showTools}
                            onChange={(showTools) =>
                                options.onDisplayChange({ ...options.display, showTools })
                            }
                        />
                    </div>
                </>
            )}
            {save.error && <ErrorNotice error={save.error} />}
            <ActionGroup>
                <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
                    Cancel
                </Button>
                <Button type="submit" busy={save.isPending} disabled={!canSave}>
                    Save settings
                </Button>
            </ActionGroup>
        </form>
    );
    if (options.modelOnly)
        return (
            <ActivityPanel title="Model settings" icon={Cpu} onClose={onClose}>
                {form}
            </ActivityPanel>
        );
    return (
        <Modal title="Chat settings" onClose={onClose} dismissible={!save.isPending}>
            {form}
        </Modal>
    );
}
