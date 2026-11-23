import type { UpdatePolicy, UpdatePolicyGroupInput } from "@homelab/contracts/updates";
import { Button, ConfirmDialog } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/** Let the operator review a host-wide or fleet-wide policy change before saving it.
 * @returns The current coverage and explicit enable and disable actions for this scope.
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
        input: UpdatePolicyGroupInput;
        changed: { target: string; label: string }[];
    }>();
    const mutation = useOperation((input: UpdatePolicyGroupInput, signal) =>
        api.updates.policyGroup.mutate(input, { signal })
    );
    const enabledCount = policies.filter((policy) => policy.enabled).length;
    function review(enabled: boolean) {
        setIntent({
            input: {
                host,
                enabled,
                expected: policies.map(({ target, version, revision }) => ({
                    target,
                    version,
                    revision,
                })),
            },
            changed: policies
                .filter((policy) => policy.enabled !== enabled)
                .map((policy) => ({
                    target: policy.target,
                    label: `${policy.source} · ${policy.label}`,
                })),
        });
    }
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2">
            <div>
                <h4 className="text-sm font-semibold text-primary-50">{label}</h4>
                <p className="text-xs text-primary-400">
                    {enabledCount} of {policies.length} targets enabled
                </p>
            </div>
            <div className="flex flex-wrap gap-2">
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={
                        disabled || mutation.isPending || enabledCount === policies.length
                    }
                    onClick={() => review(true)}
                >
                    Enable all
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || mutation.isPending || enabledCount === 0}
                    onClick={() => review(false)}
                >
                    Disable all
                </Button>
            </div>
            {intent && (
                <ConfirmDialog
                    title={`${intent.input.enabled ? "Enable" : "Disable"} automatic updates for ${label}?`}
                    description={
                        intent.input.enabled
                            ? "These targets may install verified patch and minor updates. Services may restart during installation."
                            : "New automatic installations will stop for these targets. Running installations may finish."
                    }
                    confirmLabel={
                        intent.input.enabled ? "Enable updates" : "Disable updates"
                    }
                    variant={intent.input.enabled ? "primary" : "danger"}
                    onClose={() => setIntent(undefined)}
                    onConfirm={async () => {
                        await mutation.mutateAsync(intent.input);
                        setIntent(undefined);
                    }}
                >
                    <ul className="max-h-52 list-disc space-y-1 overflow-auto pl-5 text-sm text-primary-300">
                        {intent.changed.map(({ target, label }) => (
                            <li key={target}>{label}</li>
                        ))}
                    </ul>
                </ConfirmDialog>
            )}
        </div>
    );
}
