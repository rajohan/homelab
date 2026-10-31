import type {
    DeploymentPolicyInput,
    DeploymentPolicySummary,
} from "@homelab/contracts/deployment";
import { FieldsForm, FormField, Modal, Select, TimePicker } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Capture explicit automatic-update scope and a daily window using shared form controls.
 * @param props - Current versioned policy and dialog dismissal.
 * @returns A policy editor; saving retains an existing pause.
 */
export function DeploymentPolicyDialog({
    policy,
    onClose,
}: {
    readonly policy: DeploymentPolicySummary;
    readonly onClose: () => void;
}) {
    const [mode, setMode] = useState(policy.mode);
    const [start, setStart] = useState(policy.window.start);
    const [minutes, setMinutes] = useState(String(policy.window.minutes));
    const update = useOperation((input: DeploymentPolicyInput, signal) =>
        api.releases.deployment.policy.mutate(input, { signal })
    );
    return (
        <Modal
            title="Deployment policy"
            description="Choose which Homelab releases may be installed automatically."
            onClose={onClose}
            dismissible={!update.isPending}
        >
            <FieldsForm
                fields={[]}
                submitLabel="Save policy"
                onCancel={onClose}
                onSubmit={async () => {
                    await update.mutateAsync({
                        target: policy.target,
                        version: policy.version,
                        mode,
                        window: { start, minutes: Number(minutes) },
                    });
                    onClose();
                }}
            >
                <div className="grid gap-4">
                    <FormField label="Updates">
                        <Select
                            value={mode}
                            onChange={setMode}
                            disabled={update.isPending}
                            options={[
                                { value: "manual", label: "Manual" },
                                { value: "patch", label: "Automatic patch releases" },
                                {
                                    value: "minor",
                                    label: "Automatic patch and minor releases",
                                },
                            ]}
                        />
                    </FormField>
                    {mode !== "manual" && (
                        <>
                            <TimePicker
                                label="Daily window starts"
                                value={start}
                                onChange={setStart}
                                disabled={update.isPending}
                            />
                            <FormField label="Window length">
                                <Select
                                    value={minutes}
                                    onChange={setMinutes}
                                    disabled={update.isPending}
                                    options={[15, 30, 60, 120, 240].map((value) => ({
                                        value: String(value),
                                        label: `${value} minutes`,
                                    }))}
                                />
                            </FormField>
                            <p className="text-sm text-primary-300">
                                Times follow the server clock ({policy.timeZone}). Active
                                work finishes before deployment. Major releases and
                                database changes require manual confirmation.
                            </p>
                        </>
                    )}
                    {policy.paused && (
                        <p className="text-sm text-primary-300">
                            This policy stays paused until you resume it.
                        </p>
                    )}
                </div>
            </FieldsForm>
        </Modal>
    );
}
