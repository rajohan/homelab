import type { MiraChatSettings, MiraModel } from "@homelab/contracts/mira";
import { ActionGroup, Button, ErrorNotice, Modal, Switch } from "@homelab/ui";
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
 * Edit durable conversation preferences using the runtime's advertised model capabilities.
 * @returns A viewport-bounded shared dialog; selections take effect on the next submitted turn.
 */
export function ChatSettings({
    voice,
    id,
    version,
    settings,
    models,
    defaultModel,
    fresh,
    onClose,
    display,
    onDisplayChange,
    modelOnly = false,
    activeRun = false,
}: {
    readonly voice: MiraVoiceConnection;
    readonly id: string;
    readonly version: number;
    readonly settings: MiraChatSettings;
    readonly models: MiraModel[];
    readonly defaultModel: string | null;
    readonly fresh: boolean;
    readonly onClose: () => void;
    readonly display: ChatDisplaySettings;
    readonly onDisplayChange: (display: ChatDisplaySettings) => void;
    readonly modelOnly?: boolean;
    readonly activeRun?: boolean;
}) {
    const [original] = useState({ settings, version });
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
        (!modelOnly || modelChanged) && (!modelChanged || (fresh && supported));
    const save = useOperation(() =>
        api.mira.conversations.settings.mutate({
            id,
            version: original.version,
            settings: draft,
        })
    );
    return (
        <Modal
            title={modelOnly ? "Model settings" : "Chat settings"}
            onClose={onClose}
            dismissible={!save.isPending}
        >
            <form
                className="grid grid-cols-1 gap-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!canSave || save.isPending) return;
                    void save
                        .mutateAsync(undefined)
                        .then(onClose)
                        .catch(() => {});
                }}
            >
                {modelOnly && activeRun && (
                    <p className="text-sm text-primary-300">
                        Changes apply to the next run. The current run keeps its settings.
                    </p>
                )}
                {!fresh && (
                    <p className="text-sm text-primary-300">
                        {modelOnly
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
                {!modelOnly && (
                    <>
                        <VoiceSettings voice={voice} />
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
                                checked={display.showThinking}
                                onChange={(showThinking) =>
                                    onDisplayChange({ ...display, showThinking })
                                }
                            />
                            <Switch
                                label="Show tools"
                                checked={display.showTools}
                                onChange={(showTools) =>
                                    onDisplayChange({ ...display, showTools })
                                }
                            />
                        </div>
                    </>
                )}
                {save.error && <ErrorNotice error={save.error} />}
                <ActionGroup>
                    <Button
                        variant="secondary"
                        onClick={onClose}
                        disabled={save.isPending}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" busy={save.isPending} disabled={!canSave}>
                        Save settings
                    </Button>
                </ActionGroup>
            </form>
        </Modal>
    );
}
