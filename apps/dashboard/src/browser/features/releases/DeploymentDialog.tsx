import { ConfirmDialog, ErrorNotice, LoadingState } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import { waitForJob } from "../jobs/waitForJob";
import { useOperation } from "../operations/useOperation";

/**
 * Check the selected deployment before confirming its frozen release with shared identity verification.
 * @param props - Configured deployment target and cancellation callback.
 * @returns The shared deployment-impact dialog.
 */
export function DeploymentDialog({
    target,
    onClose,
}: {
    readonly target: { id: string; label: string };
    readonly onClose: () => void;
}) {
    const [requestId] = useState(() => crypto.randomUUID());
    const query = useQuery({
        queryKey: ["release-preparation", target.id, requestId],
        queryFn: async ({ signal }) => {
            const { id } = await api.jobs.run.mutate(
                { action: `homelab.prepare.${target.id}`, requestId },
                { signal }
            );
            await waitForJob(id, signal);
            const overview = await api.releases.deployment.overview.query(undefined, {
                signal,
            });
            const plan = overview.targets.find((entry) => entry.id === target.id);
            if (
                overview.history.some((entry) => entry.active) ||
                !plan?.version ||
                !plan.revision
            )
                throw new Error(
                    "The current release could not be prepared. Close this dialog and try again."
                );
            return { version: plan.version, revision: plan.revision };
        },
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        retry: false,
    });
    const plan = query.data;
    const disabled = query.isPending || query.isFetching || query.isError || !plan;
    const operation = useOperation(
        (input: { target: string; revision: string; requestId: string }, signal) =>
            api.releases.deployment.request.mutate(input, { signal })
    );
    return (
        <ConfirmDialog
            title={plan ? `Deploy ${plan.version}?` : "Deploy release"}
            description={
                plan
                    ? `Update ${target.label} after active work finishes.`
                    : "Checking the release and current services before confirmation."
            }
            confirmLabel="Deploy release"
            confirmDisabled={disabled}
            onClose={onClose}
            onConfirm={async () => {
                if (disabled || !plan)
                    throw new Error("The release checks are not complete.");
                await operation.mutateAsync({
                    target: target.id,
                    revision: plan.revision,
                    requestId,
                });
                onClose();
            }}
        >
            {(query.isPending || query.isFetching) && (
                <LoadingState label="Checking the release and current services…" />
            )}
            {query.isError && <ErrorNotice error={query.error} />}
            <p className="text-sm text-primary-300">
                The dashboard and Mira will be briefly unavailable. Queued work is
                preserved. A database backup is taken before migration, and the host
                verifies the services before work resumes.
            </p>
        </ConfirmDialog>
    );
}
