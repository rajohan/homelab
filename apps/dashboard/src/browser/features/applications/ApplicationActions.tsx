import type {
    ApplicationIntent,
    ApplicationSelection,
} from "@homelab/contracts/applications";
import { ConfirmDialog, DropdownMenu } from "@homelab/ui";
import { Play, Square, RotateCw } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useJobOperation } from "../jobs/useJobOperation";

const operations = [
    { id: "start", label: "Start", icon: Play },
    { id: "stop", label: "Stop", icon: Square },
    { id: "restart", label: "Restart", icon: RotateCw },
] as const;

/**
 * Confirm a stable application selection before submitting an idempotent worker job.
 * @returns Lifecycle actions whose accepted runs appear in the shared job activity panel.
 */
export function ApplicationActions({
    host,
    selection,
    revision,
    name,
    disabled = false,
}: {
    readonly host: string;
    readonly selection: ApplicationSelection;
    readonly revision: string;
    readonly name: string;
    readonly disabled?: boolean;
}) {
    const [intent, setIntent] = useState<ApplicationIntent>();
    const request = useJobOperation((input: ApplicationIntent, signal) =>
        api.applications.request.mutate(input, { signal })
    );
    const verb =
        operations.find((operation) => operation.id === intent?.operation)?.label ??
        "Confirm";
    return (
        <>
            <DropdownMenu
                label={`Actions for ${name}`}
                disabled={disabled || request.isPending}
                actions={operations.map((operation) => ({
                    ...operation,
                    onSelect: () =>
                        setIntent({
                            host,
                            selection,
                            revision,
                            operation: operation.id,
                            requestId: crypto.randomUUID(),
                        }),
                }))}
            />
            {intent && (
                <ConfirmDialog
                    title={`${verb} ${name}?`}
                    description={
                        intent.operation === "start"
                            ? "Start the selected existing containers. Configuration and images will not change."
                            : "This interrupts the selected applications. A partially completed operation is not retried automatically; inspect the run before trying again."
                    }
                    variant={intent.operation === "start" ? "primary" : "danger"}
                    confirmLabel={verb}
                    onClose={() => setIntent(undefined)}
                    onConfirm={async () => {
                        await request.mutateAsync(intent);
                        setIntent(undefined);
                    }}
                />
            )}
        </>
    );
}
