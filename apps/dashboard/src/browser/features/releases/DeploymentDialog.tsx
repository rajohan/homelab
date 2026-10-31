import { ConfirmDialog } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Confirm a prepared release using shared identity verification and stable request identity.
 * @param props - Frozen visible release and confirmation fingerprint.
 * @returns The shared deployment-impact dialog.
 */
export function DeploymentDialog({
    target,
    onClose,
}: {
    readonly target: { id: string; label: string; version: string; revision: string };
    readonly onClose: () => void;
}) {
    const [requestId] = useState(() => crypto.randomUUID());
    const operation = useOperation(
        (input: { target: string; revision: string; requestId: string }, signal) =>
            api.releases.deployment.request.mutate(input, { signal })
    );
    return (
        <ConfirmDialog
            title={`Deploy ${target.version}?`}
            description={`Update ${target.label} after active work finishes.`}
            confirmLabel="Deploy release"
            onClose={onClose}
            onConfirm={async () => {
                await operation.mutateAsync({
                    target: target.id,
                    revision: target.revision,
                    requestId,
                });
                onClose();
            }}
        >
            <p className="text-sm text-primary-300">
                The dashboard and Mira will be briefly unavailable. Queued work is
                preserved. A database backup is taken before migration, and the host
                verifies the services before work resumes.
            </p>
        </ConfirmDialog>
    );
}
