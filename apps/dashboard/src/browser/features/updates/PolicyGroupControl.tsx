import type { UpdatePolicy, UpdatePolicyGroupInput } from "@homelab/contracts/updates";
import { ChoiceBar, ConfirmDialog, Switch } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/** Let the operator review a host-wide or fleet-wide policy change before saving it.
 * @returns A group switch and a confirmation listing the affected targets.
 */
export function PolicyGroupControl({
    label,
    host,
    policies,
    disabled,
}: {
    readonly label: string;
    readonly host: string | null;
    readonly policies: readonly UpdatePolicy[];
    readonly disabled: boolean;
}) {
    const [intent, setIntent] = useState<{
        enabled: boolean;
        mixed: boolean;
        policies: readonly UpdatePolicy[];
    }>();
    const mutation = useOperation((input: UpdatePolicyGroupInput, signal) =>
        api.updates.policyGroup.mutate(input, { signal })
    );
    const enabledCount = policies.filter((policy) => policy.enabled).length;
    const mixed = enabledCount > 0 && enabledCount < policies.length;
    return (
        <div className="py-3">
            <Switch
                label={label}
                description={`${enabledCount} of ${policies.length} targets enabled`}
                checked={policies.length > 0 && enabledCount === policies.length}
                indeterminate={mixed}
                disabled={disabled || mutation.isPending || policies.length === 0}
                onChange={(enabled) => setIntent({ enabled, mixed, policies })}
            />
            {intent && (
                <ConfirmDialog
                    title={`${intent.enabled ? "Enable" : "Disable"} automatic updates for ${label}?`}
                    description={
                        intent.enabled
                            ? "These targets may install verified patch and minor updates. Services may restart during installation."
                            : "New automatic installations will stop for these targets. Running installations may finish."
                    }
                    confirmLabel={intent.enabled ? "Enable updates" : "Disable updates"}
                    variant={intent.enabled ? "primary" : "danger"}
                    confirmDisabled={disabled}
                    onClose={() => setIntent(undefined)}
                    onConfirm={async () => {
                        await mutation.mutateAsync({
                            host,
                            enabled: intent.enabled,
                            expected: intent.policies.map(
                                ({ target, version, revision }) => ({
                                    target,
                                    version,
                                    revision,
                                })
                            ),
                        });
                        setIntent(undefined);
                    }}
                >
                    {intent.mixed && (
                        <ChoiceBar
                            label="Group update policy"
                            value={intent.enabled ? "enable" : "disable"}
                            options={[
                                { value: "enable", label: "Enable all" },
                                { value: "disable", label: "Disable all" },
                            ]}
                            onChange={(value) =>
                                setIntent({ ...intent, enabled: value === "enable" })
                            }
                        />
                    )}
                    <ul className="max-h-52 list-disc space-y-1 overflow-auto pl-5 text-sm text-primary-300">
                        {intent.policies
                            .filter((policy) => policy.enabled !== intent.enabled)
                            .map((policy) => (
                                <li key={policy.target}>
                                    {policy.source} · {policy.label}
                                </li>
                            ))}
                    </ul>
                </ConfirmDialog>
            )}
        </div>
    );
}
