import { buttonStyles, ConfirmDialog, ErrorNotice, LoadingState } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

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
    const preparationId = useRef(requestId);
    const query = useQuery({
        queryKey: ["release-preparation", target.id, requestId],
        queryFn: async ({ signal }) => {
            const { id } = await api.jobs.run.mutate(
                {
                    action: `homelab.prepare.${target.id}`,
                    requestId: preparationId.current,
                },
                { signal }
            );
            await waitForJob(id, signal);
            const overview = await api.releases.deployment.overview.query(undefined, {
                signal,
            });
            const plan = overview.targets.find((entry) => entry.id === target.id);
            if (plan?.publication && !overview.history.some((entry) => entry.active)) {
                // A new read is safe only after the previous check completed.
                if (plan.publication.state === "publishing")
                    preparationId.current = crypto.randomUUID();
                return { plan: null, publication: plan.publication };
            }
            if (
                overview.history.some((entry) => entry.active) ||
                !plan?.version ||
                !plan.revision
            )
                throw new Error(
                    "The current release could not be prepared. Close this dialog and try again."
                );
            return {
                plan: { version: plan.version, revision: plan.revision },
                publication: null,
            };
        },
        refetchInterval: (query) =>
            query.state.status !== "error" &&
            query.state.data?.publication?.state === "publishing"
                ? 15_000
                : false,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        retry: false,
    });
    const plan = query.data?.plan;
    const publication = query.data?.publication;
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
            {!publication && (query.isPending || query.isFetching) && (
                <LoadingState label="Checking the release and current services…" />
            )}
            {!query.isError && publication?.state === "publishing" && (
                <LoadingState
                    label={`Release ${publication.version} is still publishing. Checking automatically…`}
                />
            )}
            {publication && publication.state !== "publishing" && (
                <ErrorNotice
                    error={
                        new Error(
                            publication.state === "failed"
                                ? `Release ${publication.version} could not be published. Inspect the release build before trying again.`
                                : `Release ${publication.version} is missing verified packages. Inspect the release build before trying again.`
                        )
                    }
                />
            )}
            {publication?.buildUrl && (
                <a
                    className={buttonStyles({
                        variant: "secondary",
                        size: "sm",
                        fullWidth: true,
                    })}
                    href={publication.buildUrl}
                    target="_blank"
                    rel="noreferrer"
                >
                    View release build
                </a>
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
