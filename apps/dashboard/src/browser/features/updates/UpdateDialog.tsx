import type { UpdateItem } from "@homelab/contracts/updates";
import { ConfirmDialog, ErrorNotice, LoadingState } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../../api/client";
import { useJobOperation } from "../jobs/useJobOperation";
import { prepareUpdate } from "./prepareUpdate";
import { updateVersion } from "./updateVersion";

function installationDescription(kind: UpdateItem["kind"]): string {
    if (kind === "runtime")
        return "The shared runtime and its default entrypoints will change. Existing version-pinned projects retain their current runtime.";
    if (kind === "container")
        return "The Compose image pin will be updated and the selected service recreated.";
    return "Required dependencies may also be updated.";
}

/**
 * Refresh one target before presenting its exact current version for approval.
 * @param props - Initially selected item, deployment-owned target and close callback.
 * @returns A cancellable confirmation disabled until the common worker check succeeds.
 */
export function UpdateDialog({
    item,
    target,
    onClose,
}: {
    readonly item: UpdateItem;
    readonly target: string;
    readonly onClose: () => void;
}) {
    const [requestId] = useState(() => crypto.randomUUID());
    const query = useQuery({
        queryKey: ["operations", "updates", "single", target, item.id],
        queryFn: async ({ signal }) => {
            await prepareUpdate({ target, requestId }, signal);
            return api.updates.plan.query({ target, item: item.id }, { signal });
        },
        refetchOnWindowFocus: false,
        retry: false,
    });
    const operation = useJobOperation(
        (
            input: { target: string; item: string; revision: string; requestId: string },
            signal
        ) => api.updates.request.mutate(input, { signal })
    );
    const plan = query.data;
    const disabled =
        query.isPending || query.isFetching || query.isError || !plan?.control.allowed;
    return (
        <ConfirmDialog
            title={`Update ${item.name}?`}
            description={
                plan
                    ? `Install ${updateVersion(plan.item, "available")}. ${installationDescription(plan.item.kind)} Services may be interrupted. The host will not restart automatically.${plan.control.change === "major" ? " This is a major upgrade." : ""}`
                    : "Reading current versions before preparing the update."
            }
            confirmLabel="Update"
            confirmDisabled={disabled}
            variant={plan?.control.change === "major" ? "danger" : "primary"}
            onClose={onClose}
            onConfirm={async () => {
                if (disabled || !plan)
                    throw new Error("The current update plan is not ready.");
                await operation.mutateAsync({
                    target,
                    item: plan.item.id,
                    revision: plan.control.revision,
                    requestId,
                });
                onClose();
            }}
        >
            {(query.isPending || query.isFetching) && (
                <LoadingState label="Reading current package versions and preparing the update plan…" />
            )}
            {query.isError && <ErrorNotice error={query.error} />}
            {plan?.control.reason && (
                <p className="text-sm text-primary-400">{plan.control.reason}</p>
            )}
        </ConfirmDialog>
    );
}
