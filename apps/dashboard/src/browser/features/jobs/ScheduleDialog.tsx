import type {
    ScheduleConfiguration,
    ScheduleSummary,
} from "@homelab/contracts/operations";
import { FormField, Select, FieldsForm, Modal } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import {
    scheduleFields,
    scheduleFromValues,
    validateScheduleValues,
} from "./scheduleForm";

const descriptions = {
    cron: "Five fields: minute, hour, day of month, month, day of week. For example, 0 4 * * * runs every day at 04:00.",
    daily: "Runs once a day at the selected time, following the system clock.",
    interval: "Missed intervals are combined into one run rather than replayed.",
} as const;

/**
 * Edit interval, daily or five-field cron schedules using the single system clock.
 * @returns A validated cadence editor with no per-job time zone setting.
 */
export function ScheduleDialog({
    schedule,
    onClose,
}: {
    readonly schedule: ScheduleSummary;
    readonly onClose: () => void;
}) {
    const [kind, setKind] = useState(schedule.schedule.kind);
    const update = useOperation((configuration: ScheduleConfiguration, signal) =>
        api.schedules.update.mutate(
            { id: schedule.id, version: schedule.version, schedule: configuration },
            { signal }
        )
    );
    return (
        <Modal
            title="Edit schedule"
            description={schedule.label}
            onClose={onClose}
            dismissible={!update.isPending}
        >
            <div className="space-y-4">
                <FormField label="Schedule type">
                    <Select
                        value={kind}
                        onChange={setKind}
                        disabled={update.isPending}
                        options={[
                            { value: "daily", label: "Daily" },
                            { value: "interval", label: "Interval" },
                            { value: "cron", label: "Cron" },
                        ]}
                    />
                </FormField>
                <FieldsForm
                    key={kind}
                    fields={scheduleFields(kind, schedule.schedule)}
                    validate={(values) => validateScheduleValues(kind, values)}
                    submitLabel="Save schedule"
                    onCancel={onClose}
                    onSubmit={async (values) => {
                        await update.mutateAsync(scheduleFromValues(kind, values));
                        onClose();
                    }}
                >
                    <p className="text-xs text-primary-400">{descriptions[kind]}</p>
                </FieldsForm>
            </div>
        </Modal>
    );
}
