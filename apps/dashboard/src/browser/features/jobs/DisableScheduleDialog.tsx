import type { ScheduleSummary } from "@homelab/contracts/operations";
import {
    FieldsForm,
    DateTimePicker,
    dateTimePickerValue,
    dateTimePickerTimestamp,
    Modal,
    Switch,
} from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Capture explicit disable intent and an optional automatic resume time.
 * @returns A reasoned pause that is not reported as a failed scheduled job.
 */
export function DisableScheduleDialog({
    schedule,
    onClose,
}: {
    readonly schedule: ScheduleSummary;
    readonly onClose: () => void;
}) {
    const [timed, setTimed] = useState(schedule.disabledUntil !== null);
    const [openedAt] = useState(Date.now);
    const [until, setUntil] = useState(() =>
        dateTimePickerValue(schedule.disabledUntil ?? openedAt + 3_600_000)
    );
    const timestamp = dateTimePickerTimestamp(until);
    const invalidUntil = !Number.isFinite(timestamp) || timestamp <= openedAt;
    const update = useOperation(
        (input: { reason: string; until: number | null }, signal) =>
            api.schedules.setEnabled.mutate(
                { ...input, id: schedule.id, version: schedule.version, enabled: false },
                { signal }
            )
    );
    return (
        <Modal
            title="Disable schedule"
            description="Scheduled runs stop until you enable the schedule again or the resume time is reached. Running and queued jobs are unchanged."
            onClose={onClose}
            dismissible={!update.isPending}
        >
            <FieldsForm
                fields={[
                    {
                        name: "reason",
                        label: "Reason",
                        initial: schedule.disableReason ?? "",
                        maximum: 1000,
                        placeholder: "For example, planned maintenance",
                    },
                ]}
                submitLabel="Disable schedule"
                onCancel={onClose}
                isSubmitDisabled={() => timed && invalidUntil}
                onSubmit={async (values) => {
                    await update.mutateAsync({
                        reason: values.reason ?? "",
                        until: timed ? timestamp : null,
                    });
                    onClose();
                }}
            >
                <div className="space-y-4">
                    <Switch
                        label="Resume automatically"
                        checked={timed}
                        onChange={setTimed}
                        description="Otherwise, the schedule stays disabled until you enable it."
                    />
                    {timed && (
                        <DateTimePicker
                            label="Resume at"
                            value={until}
                            onChange={setUntil}
                            minimumDate={new Date(openedAt)}
                            disabled={update.isPending}
                            error={
                                invalidUntil
                                    ? "Choose a valid future date and time."
                                    : undefined
                            }
                        />
                    )}
                </div>
            </FieldsForm>
        </Modal>
    );
}
