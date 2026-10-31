import type { DeploymentPolicySummary } from "@homelab/contracts/deployment";
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
 * Pause one deployment policy with a reason and optional explicit resumption time.
 * @param props - Versioned policy and dialog dismissal.
 * @returns Shared pause controls which leave already submitted deployments running.
 */
export function DeploymentPauseDialog({
    policy,
    onClose,
}: {
    readonly policy: DeploymentPolicySummary;
    readonly onClose: () => void;
}) {
    const [timed, setTimed] = useState(policy.until !== null);
    const [openedAt] = useState(Date.now);
    const [until, setUntil] = useState(() =>
        dateTimePickerValue(policy.until ?? openedAt + 3_600_000)
    );
    const timestamp = dateTimePickerTimestamp(until);
    const invalidUntil = !Number.isFinite(timestamp) || timestamp <= openedAt;
    const update = useOperation(
        (input: { reason: string; until: number | null }, signal) =>
            api.releases.deployment.pause.mutate(
                {
                    ...input,
                    target: policy.target,
                    version: policy.version,
                    paused: true,
                },
                { signal }
            )
    );
    return (
        <Modal
            title="Pause deployment"
            description="Automatic deployment stops until you resume it. A deployment that has already started will finish."
            onClose={onClose}
            dismissible={!update.isPending}
        >
            <FieldsForm
                fields={[
                    {
                        name: "reason",
                        label: "Reason",
                        initial: policy.reason ?? "",
                        maximum: 1000,
                        placeholder: "For example, planned maintenance",
                    },
                ]}
                submitLabel="Pause deployment"
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
                        description="Otherwise, deployment stays paused until you resume it."
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
