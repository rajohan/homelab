import type { MiraChatSettings, MiraModel } from "@homelab/contracts/mira";
import { FormField, Select } from "@homelab/ui";

/**
 * Share current provider, model and capability choices between Chat and Automations.
 * @returns Controlled fields; alias IDs remain unchanged when their underlying model rotates.
 */
export function ModelSettings({
    draft,
    setDraft,
    models,
    defaultModel,
    fresh,
    disabled = false,
    label = "Chat model",
}: {
    readonly draft: MiraChatSettings;
    readonly setDraft: (settings: MiraChatSettings) => void;
    readonly models: MiraModel[];
    readonly defaultModel: string | null;
    readonly fresh: boolean;
    readonly disabled?: boolean;
    readonly label?: string;
}) {
    const provider = (draft.model ?? defaultModel)?.startsWith("syn:")
        ? "synthetic"
        : "chatgpt";
    const selected =
        models.find((model) => model.model === (draft.model ?? defaultModel)) ??
        (draft.model ? undefined : models.find((model) => model.isDefault));
    const thinking = selected?.supportedReasoningEfforts.find(
        (entry) =>
            entry.reasoningEffort === (draft.effort ?? selected.defaultReasoningEffort)
    );
    const speed = selected?.serviceTiers.find(
        (entry) => entry.id === (draft.serviceTier ?? selected.defaultServiceTier)
    );
    const modelOptions = [
        ...((defaultModel?.startsWith("syn:") ? "synthetic" : "chatgpt") === provider
            ? [{ value: "", label: "Default model" }]
            : []),
        ...models
            .filter(
                (entry) => entry.model.startsWith("syn:") === (provider === "synthetic")
            )
            .map((model) => ({
                value: model.model,
                label: model.displayName || model.model,
            })),
    ];
    if (draft.model && !models.some((model) => model.model === draft.model))
        modelOptions.push({ value: draft.model, label: `${draft.model} (unavailable)` });

    return (
        <>
            <FormField label="Provider">
                <Select
                    label="Model provider"
                    value={provider}
                    disabled={!fresh || disabled}
                    options={[
                        {
                            value: "chatgpt",
                            label: "ChatGPT subscription",
                            disabled: !models.some(
                                (entry) => !entry.model.startsWith("syn:")
                            ),
                        },
                        ...(provider === "synthetic" ||
                        models.some((entry) => entry.model.startsWith("syn:"))
                            ? [{ value: "synthetic", label: "Synthetic subscription" }]
                            : []),
                    ]}
                    onChange={(next) => {
                        if (
                            next === "chatgpt" &&
                            defaultModel &&
                            !defaultModel.startsWith("syn:") &&
                            models.some((entry) => entry.model === defaultModel)
                        ) {
                            setDraft({
                                ...draft,
                                model: null,
                                effort: null,
                                serviceTier: null,
                            });
                            return;
                        }
                        setDraft({
                            ...draft,
                            model:
                                next === "synthetic"
                                    ? (models.find(
                                          (entry) => entry.model === "syn:large:text"
                                      )?.model ??
                                      models.find((entry) =>
                                          entry.model.startsWith("syn:")
                                      )?.model ??
                                      "syn:large:text")
                                    : (models.find(
                                          (entry) =>
                                              !entry.model.startsWith("syn:") &&
                                              entry.isDefault
                                      )?.model ??
                                      models.find(
                                          (entry) => !entry.model.startsWith("syn:")
                                      )?.model ??
                                      null),
                            effort: null,
                            serviceTier: null,
                        });
                    }}
                />
            </FormField>
            <FormField label="Model">
                <Select
                    label={label}
                    value={draft.model ?? ""}
                    disabled={!fresh || disabled}
                    options={modelOptions}
                    onChange={(model) => {
                        const next = models.find(
                            (entry) => entry.model === (model || defaultModel)
                        );
                        setDraft({
                            ...draft,
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
                        disabled={!fresh || disabled || !selected}
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
                        <p className="text-xs text-primary-400">{thinking.description}</p>
                    )}
                </FormField>
                <FormField label="Speed">
                    <Select
                        label="Response speed"
                        value={draft.serviceTier ?? ""}
                        disabled={!fresh || disabled || !selected}
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
                        <p className="text-xs text-primary-400">{speed.description}</p>
                    )}
                </FormField>
            </div>
        </>
    );
}
