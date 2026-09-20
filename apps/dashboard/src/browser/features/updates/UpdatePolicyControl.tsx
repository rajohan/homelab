import type { UpdatePolicy } from "@homelab/contracts/updates";
import { ConfirmDialog, Switch } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

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
    const [intent, setIntent] = useState<{ enabled: boolean; version: number }>();
    const operation = useOperation(
        (input: { target: string; enabled: boolean; version: number }, signal) =>
            api.updates.policy.mutate(input, { signal })
    );
    return (
        <div className="rounded-lg border border-primary-700 bg-primary-950/40 p-4">
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
            {intent && (
                <ConfirmDialog
                    title={`${intent.enabled ? "Enable" : "Disable"} automatic updates?`}
                    description={
                        intent.enabled
                            ? `${policy.label} may install verified patch and minor updates through the worker. Services may restart during installation. Unknown versions, held packages and major upgrades require manual action.`
                            : `No new automatic updates will start for ${policy.label}. An installation already in progress may still complete.`
                    }
                    confirmLabel={intent.enabled ? "Enable updates" : "Disable updates"}
                    variant={intent.enabled ? "primary" : "danger"}
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
