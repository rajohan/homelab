import type { MiraChatSettings, MiraModel } from "@homelab/contracts/mira";
import { ActionGroup, Button, ErrorNotice, Modal, Switch } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { AssistanceSettings } from "./AssistanceSettings";
import type { ChatDisplaySettings } from "./chatDisplay";
import { ModelSettings } from "./ModelSettings";
import { PermissionSettings } from "./PermissionSettings";
import { RecallSettings } from "./RecallSettings";

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
    const [original] = useState({ settings, version });
    const [draft, setDraft] = useState(settings);
    const modelChanged =
        draft.model !== original.settings.model ||
        draft.effort !== original.settings.effort ||
        draft.serviceTier !== original.settings.serviceTier;
    const selected =
        models.find((model) => model.model === (draft.model ?? defaultModel)) ??
        (draft.model ? undefined : models.find((model) => model.isDefault));
    const save = useOperation(() =>
        api.mira.conversations.settings.mutate({
            id,
            version: original.version,
            settings: draft,
        })
    );
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
                <p className="text-sm text-primary-300">
                    Model, thinking, code target and assistance choices apply to the next
                    run. Display changes apply immediately. Changing permissions returns
                    current work to asking for approval; the new mode applies to the next
                    run.
                </p>
                {!fresh && (
                    <p className="text-sm text-primary-300">
                        Reconnect Mira to change model choices. Other settings remain
                        available.
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
                <PermissionSettings
                    settings={draft}
                    onChange={setDraft}
                    disabled={save.isPending}
                />
                <RecallSettings
                    settings={draft}
                    onChange={setDraft}
                    disabled={save.isPending}
                />
                <AssistanceSettings
                    settings={draft}
                    onChange={setDraft}
                    disabled={save.isPending}
                />
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
                        disabled={modelChanged && (!fresh || !selected)}
                    >
                        Save settings
                    </Button>
                </ActionGroup>
            </form>
        </Modal>
    );
}
