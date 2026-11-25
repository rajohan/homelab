import type { UpdatePolicy } from "@homelab/contracts/updates";
import { ConfirmDialog, Switch } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

type PolicyIntent = { enabled: boolean; version: number; allowDigest?: boolean };

function confirmation(label: string, intent: PolicyIntent) {
    if (intent.allowDigest === true)
        return {
            title: "Allow unversioned image updates?",
            description: `${label} may install a new latest digest when neither image has a version. The size of the change is unknown, and the service may restart.`,
            confirmLabel: "Allow digest updates",
        };
    if (intent.allowDigest === false)
        return {
            title: "Stop unversioned image updates?",
            description: `Unversioned changes for ${label} will require manual installation.`,
            confirmLabel: "Stop digest updates",
        };
    return {
        title: `${intent.enabled ? "Enable" : "Disable"} automatic updates?`,
        description: intent.enabled
            ? `${label} may install verified patch and minor updates. Services may restart during installation.`
            : `No new automatic updates will start for ${label}. An installation already in progress may still complete.`,
        confirmLabel: intent.enabled ? "Enable updates" : "Disable updates",
    };
}

/**
 * Confirm per-target automatic update consent without treating a switch click as approval.
 * @param props - Current server policy; changed deployment recipes invalidate previous consent.
 * @returns A shared switch and verified confirmation dialog.
 */
export function UpdatePolicyControl({
    policy,
    disabled,
}: {
    readonly policy: UpdatePolicy;
    readonly disabled: boolean;
}) {
    const [intent, setIntent] = useState<PolicyIntent>();
    const operation = useOperation(
        (
            input: {
                target: string;
                enabled: boolean;
                version: number;
                allowDigest?: boolean;
            },
            signal
        ) => api.updates.policy.mutate(input, { signal })
    );
    return (
        <div className="p-4">
            <Switch
                label={policy.label}
                checked={policy.enabled}
                disabled={disabled || operation.isPending}
                description={
                    policy.configurationChanged
                        ? "The update configuration changed. Review it before enabling automatic updates again."
                        : "Automatic patch and minor updates. Major upgrades and host restarts remain manual."
                }
                onChange={(enabled) => setIntent({ enabled, version: policy.version })}
            />
            {policy.allowDigest !== undefined && (
                <div className="mt-3 border-t border-primary-700 pt-3">
                    <Switch
                        label="Allow unversioned images"
                        checked={policy.allowDigest}
                        disabled={disabled || !policy.enabled || operation.isPending}
                        description="When latest has no version number, install a verified change to this service's image digest."
                        onChange={(allowDigest) =>
                            setIntent({
                                enabled: true,
                                allowDigest,
                                version: policy.version,
                            })
                        }
                    />
                </div>
            )}
            {intent && (
                <ConfirmDialog
                    {...confirmation(policy.label, intent)}
                    variant={
                        (intent.allowDigest ?? intent.enabled) ? "primary" : "danger"
                    }
                    onClose={() => setIntent(undefined)}
                    onConfirm={async () => {
                        if (disabled || policy.version !== intent.version)
                            throw new Error(
                                "The update policy changed. Refresh and try again."
                            );
                        await operation.mutateAsync({ target: policy.target, ...intent });
                        setIntent(undefined);
                    }}
                />
            )}
        </div>
    );
}
