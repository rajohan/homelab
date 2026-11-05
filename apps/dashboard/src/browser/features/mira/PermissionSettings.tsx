import { miraPermissionModeSchema, type MiraChatSettings } from "@homelab/contracts/mira";
import { FormField, Select } from "@homelab/ui";
import * as v from "valibot";

const descriptions = {
    ask: "Approve browser sessions, task changes, code jobs, emails and publications.",
    approve_for_me:
        "Mira can read websites available to your account, update tasks and run fixed Homelab source, edit and test jobs on your selected code target. Emails and publications still need your approval.",
    full_access:
        "Mira can navigate, click and type on websites available to your account, update tasks, run code jobs, send email and publish through your enabled integrations. GitHub publication creates a draft PR; merging and deployment remain separate.",
};

/**
 * Share durable per-conversation permission choices across web and Windows.
 * @returns A controlled mode selector; saving settings grants only the described action classes.
 */
export function PermissionSettings({
    settings,
    onChange,
    disabled = false,
}: {
    readonly settings: MiraChatSettings;
    readonly onChange: (settings: MiraChatSettings) => void;
    readonly disabled?: boolean;
}) {
    const mode = settings.permissionMode ?? "ask";
    return (
        <div className="space-y-2">
            <FormField label="Permissions" description={descriptions[mode]}>
                <Select
                    label="Permissions"
                    value={mode}
                    disabled={disabled}
                    options={[
                        { value: "ask", label: "Ask for approval" },
                        { value: "approve_for_me", label: "Approve for me" },
                        { value: "full_access", label: "Full access" },
                    ]}
                    onChange={(value) =>
                        onChange({
                            ...settings,
                            permissionMode: v.parse(miraPermissionModeSchema, value),
                        })
                    }
                />
            </FormField>
            <p className="text-sm text-primary-400">
                Applies to this Chat and task work in it. Saved browser profiles and PC
                access have separate controls. Code jobs use the selected target and its
                resource limits; Daytona consumes cloud credits.
            </p>
        </div>
    );
}
