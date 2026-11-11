import {
    type MiraChatSettings,
    miraLiveAssistanceMinutesSchema,
} from "@homelab/contracts/mira";
import { FormField, Select } from "@homelab/ui";
import * as v from "valibot";

/**
 * Configure continued assistance in the shared web and Windows chat.
 * @returns An explicit duration choice; computer access still needs separate local consent.
 */
export function AssistanceSettings({
    settings,
    onChange,
    disabled = false,
}: {
    readonly settings: MiraChatSettings;
    readonly onChange: (settings: MiraChatSettings) => void;
    readonly disabled?: boolean;
}) {
    return (
        <FormField
            label="Live computer assistance"
            description="Keep observing and helping after replies while your approved computer access is active. Uses your selected model throughout the session. Stop at any time. Task-linked chats and automations finish normally."
        >
            <Select
                label="Live computer assistance"
                value={String(settings.liveAssistanceMinutes ?? 0)}
                disabled={disabled}
                options={[
                    { value: "0", label: "Off · finish after the reply" },
                    { value: "-1", label: "Until finished or stopped" },
                    { value: "30", label: "Continue for up to 30 minutes" },
                    { value: "60", label: "Continue for up to 1 hour" },
                    { value: "120", label: "Continue for up to 2 hours" },
                ]}
                onChange={(value) =>
                    onChange({
                        ...settings,
                        liveAssistanceMinutes: v.parse(
                            miraLiveAssistanceMinutesSchema,
                            Number(value)
                        ),
                    })
                }
            />
        </FormField>
    );
}
