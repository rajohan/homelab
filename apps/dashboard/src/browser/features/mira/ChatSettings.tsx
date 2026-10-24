import type { MiraChatSettings, MiraModel } from "@homelab/contracts/mira";
import {
    ActionGroup,
    Button,
    ErrorNotice,
    FormField,
    Modal,
    Select,
    Switch,
} from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import type { ChatDisplaySettings } from "./chatDisplay";

/**
 * Edit durable conversation preferences using the runtime's advertised model capabilities.
 * @returns A viewport-bounded shared dialog; selections take effect on the next submitted turn.
 */
export function ChatSettings({
    id,
    version,
    settings,
    models,
    defaultModel,
    fresh,
    onClose,
    display,
    onDisplayChange,
}: {
    readonly id: string;
    readonly version: number;
    readonly settings: MiraChatSettings;
    readonly models: MiraModel[];
    readonly defaultModel: string | null;
    readonly fresh: boolean;
    readonly onClose: () => void;
    readonly display: ChatDisplaySettings;
    readonly onDisplayChange: (display: ChatDisplaySettings) => void;
}) {
    const [draft, setDraft] = useState(settings);
    const selected =
        models.find((model) => model.model === (draft.model ?? defaultModel)) ??
        (draft.model ? undefined : models.find((model) => model.isDefault));
    const save = useOperation(() =>
        api.mira.conversations.settings.mutate({ id, version, settings: draft })
    );
    const thinking = selected?.supportedReasoningEfforts.find(
        (entry) =>
            entry.reasoningEffort === (draft.effort ?? selected.defaultReasoningEffort)
    );
    const speed = selected?.serviceTiers.find(
        (entry) => entry.id === (draft.serviceTier ?? selected.defaultServiceTier)
    );
    const modelOptions = [
        { value: "", label: "Default model" },
        ...models.map((model) => ({
            value: model.model,
            label: model.displayName || model.model,
        })),
    ];
    if (draft.model && !models.some((model) => model.model === draft.model))
        modelOptions.push({ value: draft.model, label: `${draft.model} (unavailable)` });
    return (
        <Modal title="Chat settings" onClose={onClose} dismissible={!save.isPending}>
            <form
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void save
                        .mutateAsync(undefined)
                        .then(onClose)
                        .catch(() => {});
                }}
            >
                {!fresh && (
                    <p className="text-sm text-primary-300">
                        Reconnect Mira to load current model choices and save settings.
                    </p>
                )}
                <FormField label="Model">
                    <Select
                        label="Chat model"
                        value={draft.model ?? ""}
                        disabled={!fresh || save.isPending}
                        options={modelOptions}
                        onChange={(model) => {
                            const next = models.find(
                                (entry) => entry.model === (model || defaultModel)
                            );
                            setDraft({
                                model: model || null,
                                effort: next?.supportedReasoningEfforts.some(
                                    (entry) => entry.reasoningEffort === draft.effort
                                )
                                    ? draft.effort
                                    : null,
                                serviceTier: next?.serviceTiers.some(
                                    (entry) => entry.id === draft.serviceTier
                                )
                                    ? draft.serviceTier
                                    : null,
                            });
                        }}
                    />
                    {selected?.description && (
                        <p className="text-xs text-primary-400">{selected.description}</p>
                    )}
                </FormField>
                <div className="grid gap-4 sm:grid-cols-2">
                    <FormField label="Thinking">
                        <Select
                            label="Thinking level"
                            value={draft.effort ?? ""}
                            disabled={!fresh || save.isPending || !selected}
                            options={[
                                {
                                    value: "",
                                    label: selected?.defaultReasoningEffort
                                        ? `Default (${selected.defaultReasoningEffort})`
                                        : "Default",
                                },
                                ...(selected?.supportedReasoningEfforts.map((entry) => ({
                                    value: entry.reasoningEffort,
                                    label:
                                        entry.reasoningEffort.charAt(0).toUpperCase() +
                                        entry.reasoningEffort.slice(1),
                                })) ?? []),
                            ]}
                            onChange={(effort) =>
                                setDraft({ ...draft, effort: effort || null })
                            }
                        />
                        {thinking && (
                            <p className="text-xs text-primary-400">
                                {thinking.description}
                            </p>
                        )}
                    </FormField>
                    <FormField label="Speed">
                        <Select
                            label="Response speed"
                            value={draft.serviceTier ?? ""}
                            disabled={!fresh || save.isPending || !selected}
                            options={[
                                {
                                    value: "",
                                    label: selected?.defaultServiceTier
                                        ? `Default (${selected.serviceTiers.find((entry) => entry.id === selected.defaultServiceTier)?.name ?? selected.defaultServiceTier})`
                                        : "Standard",
                                },
                                ...(selected?.serviceTiers.map((entry) => ({
                                    value: entry.id,
                                    label: entry.name,
                                })) ?? []),
                            ]}
                            onChange={(serviceTier) =>
                                setDraft({ ...draft, serviceTier: serviceTier || null })
                            }
                        />
                        {speed && (
                            <p className="text-xs text-primary-400">
                                {speed.description}
                            </p>
                        )}
                    </FormField>
                </div>
                <div className="space-y-3 border-t border-primary-700 pt-4">
                    <Switch
                        label="Show work status"
                        checked={display.showActivity}
                        onChange={(showActivity) =>
                            onDisplayChange({ ...display, showActivity })
                        }
                    />
                    <Switch
                        label="Keep status after the reply"
                        checked={display.keepActivity}
                        disabled={!display.showActivity}
                        onChange={(keepActivity) =>
                            onDisplayChange({ ...display, keepActivity })
                        }
                    />
                    <Switch
                        label="Show tools"
                        checked={display.showTools}
                        onChange={(showTools) =>
                            onDisplayChange({ ...display, showTools })
                        }
                    />
                    <Switch
                        label="Expand tool details"
                        checked={display.expandTools}
                        disabled={!display.showTools}
                        onChange={(expandTools) =>
                            onDisplayChange({ ...display, expandTools })
                        }
                    />
                </div>
                {save.error && <ErrorNotice error={save.error} />}
                <ActionGroup>
                    <Button
                        variant="secondary"
                        onClick={onClose}
                        disabled={save.isPending}
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        busy={save.isPending}
                        disabled={!fresh || !selected}
                    >
                        Save settings
                    </Button>
                </ActionGroup>
            </form>
        </Modal>
    );
}
