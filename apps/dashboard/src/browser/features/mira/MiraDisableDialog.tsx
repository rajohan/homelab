import type { MiraSwitch } from "@homelab/contracts/mira";
import {
    DateTimePicker,
    dateTimePickerTimestamp,
    dateTimePickerValue,
    FieldsForm,
    Modal,
    Switch,
} from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Capture intentional pause state without converting it into a health warning.
 * @returns A shared disable dialog with a reason and optional automatic resume.
 */
export function MiraDisableDialog({
    control,
    title,
    onClose,
}: {
    readonly control: MiraSwitch;
    readonly title: string;
    readonly onClose: () => void;
}) {
    const [timed, setTimed] = useState(control.until !== null);
    const [openedAt] = useState(Date.now);
    const [until, setUntil] = useState(() =>
        dateTimePickerValue(control.until ?? openedAt + 3_600_000)
    );
    const timestamp = dateTimePickerTimestamp(until);
    const invalid = !Number.isFinite(timestamp) || timestamp <= openedAt;
    const change = useOperation((reason: string) =>
        api.mira.controls.setEnabled.mutate({
            key: control.key,
            version: control.version,
            enabled: false,
            reason,
            until: timed ? new Date(timestamp).toISOString() : null,
        })
    );
    return (
        <Modal
            title={`Pause ${title}`}
            description="Queued automatic runs will be skipped. Running work has a separate Stop control. This pause stays in place through updates."
            onClose={onClose}
            dismissible={!change.isPending}
        >
            <FieldsForm
                fields={[
                    {
                        name: "reason",
                        label: "Reason",
                        initial: control.reason ?? "",
                        maximum: 1000,
                    },
                ]}
                submitLabel="Pause"
                onCancel={onClose}
                isSubmitDisabled={() => timed && invalid}
                onSubmit={async (values) => {
                    await change.mutateAsync(values.reason ?? "");
                    onClose();
                }}
            >
                <div className="space-y-4">
                    <Switch
                        label="Resume automatically"
                        checked={timed}
                        onChange={setTimed}
                        description="Otherwise this remains paused until you enable it."
                    />
                    {timed && (
                        <DateTimePicker
                            label="Resume at"
                            value={until}
                            onChange={setUntil}
                            minimumDate={new Date(openedAt)}
                        />
                    )}
                </div>
            </FieldsForm>
        </Modal>
    );
}
