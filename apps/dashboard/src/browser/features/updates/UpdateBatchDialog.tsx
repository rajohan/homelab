import type { updateBatchRequestSchema } from "@homelab/contracts/updates";
import {
    Badge,
    Checkbox,
    ConfirmDialog,
    DataTable,
    ErrorNotice,
    LoadingState,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { InferOutput } from "valibot";

import { api } from "../../api/client";
import { useJobOperation } from "../jobs/useJobOperation";
import { updateVersion } from "./updateVersion";

/**
 * Review every included and excluded update before submitting a revision-fenced host batch.
 * @param props - Explicit source scope or all hosts, plus the caller's close callback.
 * @returns A virtualized confirmation that cannot submit a pending or failed plan.
 */
export function UpdateBatchDialog({
    source,
    label,
    onClose,
}: {
    readonly source?: string;
    readonly label?: string;
    readonly onClose: () => void;
}) {
    const [requestId] = useState(() => crypto.randomUUID());
    const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
    const query = useQuery({
        queryKey: ["operations", "updates", "batch", source ?? null],
        queryFn: ({ signal }) =>
            api.updates.batchPlan.query(source ? { source } : {}, { signal }),
        refetchOnWindowFocus: false,
        retry: false,
    });
    const operation = useJobOperation(
        (input: InferOutput<typeof updateBatchRequestSchema>, signal) =>
            api.updates.batchRequest.mutate(input, { signal })
    );
    const plan = query.data;
    const included =
        plan?.entries.filter(
            (entry) =>
                entry.reason === null &&
                !excluded.has(JSON.stringify([entry.source, entry.item.id]))
        ) ?? [];
    const disabled = query.isFetching || query.isError || !plan || included.length === 0;
    return (
        <ConfirmDialog
            title={label ? `Update all on ${label}?` : "Update all hosts?"}
            description="Updates run in sequence on each host. If an update fails, the remaining updates on that host stop. Hosts will not restart automatically."
            confirmLabel="Update all"
            confirmDisabled={disabled}
            variant="primary"
            size="wide"
            onClose={onClose}
            onConfirm={async () => {
                if (disabled || !plan) throw new Error("The update plan is not ready.");
                await operation.mutateAsync({
                    ...(source ? { source } : {}),
                    revision: plan.revision,
                    requestId,
                    items: included.map((entry) => ({
                        source: entry.source,
                        item: entry.item.id,
                    })),
                });
                onClose();
            }}
        >
            {query.isFetching && <LoadingState label="Checking available updates…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {plan && !query.isError && (
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="positive">
                            {included.length}{" "}
                            {included.length === 1 ? "update" : "updates"} included
                        </Badge>
                        <Badge>
                            {new Set(included.map((entry) => entry.source)).size} hosts
                        </Badge>
                        {plan.entries.length > included.length && (
                            <Badge tone="warning">
                                {plan.entries.length - included.length} not included
                            </Badge>
                        )}
                    </div>
                    {plan.entries.length > 0 ? (
                        <DataTable
                            label="Update plan"
                            compact
                            className="max-h-[min(26rem,50dvh)]"
                            rows={plan.entries}
                            getKey={(entry) =>
                                JSON.stringify([entry.source, entry.item.id])
                            }
                            columns={[
                                {
                                    id: "selected",
                                    label: "Include",
                                    width: "w-20",
                                    render: (entry) => {
                                        const key = JSON.stringify([
                                            entry.source,
                                            entry.item.id,
                                        ]);
                                        return (
                                            <Checkbox
                                                label={`Include ${entry.item.name} on ${entry.sourceLabel}`}
                                                checked={
                                                    entry.reason === null &&
                                                    !excluded.has(key)
                                                }
                                                disabled={
                                                    entry.reason !== null ||
                                                    operation.isPending
                                                }
                                                onChange={(checked) => {
                                                    setExcluded((current) => {
                                                        const next = new Set(current);
                                                        if (checked) next.delete(key);
                                                        else next.add(key);
                                                        return next;
                                                    });
                                                }}
                                            />
                                        );
                                    },
                                },
                                {
                                    id: "software",
                                    sortValue: (row) => row.item.name,
                                    label: "Software",
                                    mobile: "title",
                                    render: (entry) => (
                                        <div>
                                            {entry.item.name}
                                            {entry.reason && (
                                                <p className="mt-1 text-xs text-primary-400">
                                                    {entry.reason}
                                                </p>
                                            )}
                                        </div>
                                    ),
                                },
                                {
                                    id: "source",
                                    sortValue: (row) => row.sourceLabel,
                                    label: "Host",
                                    render: (entry) => entry.sourceLabel,
                                },
                                {
                                    id: "installed",
                                    sortValue: (row) => row.item.installed,
                                    label: "Installed",
                                    render: (entry) =>
                                        updateVersion(entry.item, "installed"),
                                },
                                {
                                    id: "available",
                                    sortValue: (row) => row.item.available,
                                    label: "Available",
                                    render: (entry) =>
                                        updateVersion(entry.item, "available"),
                                },
                                {
                                    id: "included",
                                    sortValue: (row) => row.control?.allowed ?? false,
                                    label: "Status",
                                    render: (entry) => (
                                        <Badge
                                            tone={
                                                entry.reason ||
                                                excluded.has(
                                                    JSON.stringify([
                                                        entry.source,
                                                        entry.item.id,
                                                    ])
                                                )
                                                    ? "neutral"
                                                    : "positive"
                                            }
                                        >
                                            {entry.reason ||
                                            excluded.has(
                                                JSON.stringify([
                                                    entry.source,
                                                    entry.item.id,
                                                ])
                                            )
                                                ? "Not included"
                                                : "Included"}
                                        </Badge>
                                    ),
                                },
                            ]}
                        />
                    ) : (
                        <p className="rounded-lg border border-primary-700 bg-primary-900 p-4 text-sm text-primary-400">
                            No updates are available.
                        </p>
                    )}
                </div>
            )}
        </ConfirmDialog>
    );
}
