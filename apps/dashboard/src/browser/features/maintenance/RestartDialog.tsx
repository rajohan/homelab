import { ConfirmDialog } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useJobOperation } from "../jobs/useJobOperation";

/**
 * Confirm a specific observed restart with shared security verification and job activity.
 * @param props - Safe server-owned plan and modal lifecycle.
 * @returns An explicit service-impact confirmation, never an automatic restart.
 */
export function RestartDialog({
    plan,
    onClose,
}: {
    readonly plan: {
        target: string;
        label: string;
        impact: string;
        kind: "host" | "service";
        revision: string;
    };
    readonly onClose: () => void;
}) {
    const [requestId] = useState(() => crypto.randomUUID());
    const operation = useJobOperation(
        (input: { target: string; revision: string; requestId: string }, signal) =>
            api.maintenance.request.mutate(input, { signal })
    );
    return (
        <ConfirmDialog
            title={`Restart ${plan.label}?`}
            description={plan.impact}
            confirmLabel="Restart"
            variant="danger"
            onClose={onClose}
            onConfirm={async () => {
                await operation.mutateAsync({
                    target: plan.target,
                    revision: plan.revision,
                    requestId,
                });
                onClose();
            }}
        >
            <p className="text-sm text-primary-300">
                {plan.kind === "host"
                    ? "The entire host will be unavailable until it boots again. Once the restart request is accepted, cancelling the job cannot undo it."
                    : "The selected service will be unavailable briefly. A stopped service will not be started by this action."}{" "}
                The job verifies recovery before reporting success.
            </p>
        </ConfirmDialog>
    );
}
