import type { updateBatchRequestSchema } from "@homelab/contracts/updates";
import {
    Badge,
    Checkbox,
    ConfirmDialog,
    DetailEntry,
    DetailFacts,
    DetailList,
    DetailSection,
    ErrorNotice,
    LoadingState,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { ListChecks, PackageCheck } from "lucide-react";
import { useState } from "react";
import type { InferOutput } from "valibot";

import { api } from "../../api/client";
import { useJobOperation } from "../jobs/useJobOperation";
import { prepareUpdate } from "./prepareUpdate";
import { updateVersion } from "./updateVersion";

/**
 * Review every included and excluded update before submitting a revision-fenced host batch.
 * @param props - Explicit source scope or all hosts, plus the caller's close callback.
 * @returns A sortable confirmation that cannot submit a pending or failed plan.
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
        queryFn: async ({ signal }) => {
            await prepareUpdate({ requestId, ...(source ? { source } : {}) }, signal);
            return api.updates.batchPlan.query(source ? { source } : {}, { signal });
        },
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
            {query.isFetching && (
                <LoadingState label="Reading current package versions and preparing the update plan…" />
            )}
            {query.isError && <ErrorNotice error={query.error} />}
            {plan && !query.isError && (
                <div className="space-y-4">
                    <DetailSection icon={ListChecks} title="Selection">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge tone="positive">
                                {included.length}{" "}
                                {included.length === 1 ? "update" : "updates"} included
                            </Badge>
                            <Badge>
                                {new Set(included.map((entry) => entry.source)).size}{" "}
                                hosts
                            </Badge>
                            {plan.entries.length > included.length && (
                                <Badge tone="warning">
                                    {plan.entries.length - included.length} not included
                                </Badge>
                            )}
                        </div>
                    </DetailSection>
                    <DetailList
                        icon={PackageCheck}
                        title="Update plan"
                        defaultField="Host"
                        rows={plan.entries}
                        getKey={(entry) => JSON.stringify([entry.source, entry.item.id])}
                        sorts={[
                            { label: "Software", value: (row) => row.item.name },
                            { label: "Host", value: (row) => row.sourceLabel },
                            { label: "Installed", value: (row) => row.item.installed },
                            { label: "Available", value: (row) => row.item.available },
                            {
                                label: "Status",
                                value: (row) =>
                                    row.reason === null &&
                                    !excluded.has(
                                        JSON.stringify([row.source, row.item.id])
                                    ),
                            },
                        ]}
                        empty="No updates are available."
                        render={(entry) => {
                            const key = JSON.stringify([entry.source, entry.item.id]);
                            const selected = entry.reason === null && !excluded.has(key);
                            return (
                                <div className="flex items-start gap-3">
                                    <span className="mt-0.5 grid min-h-6 place-items-center">
                                        <Checkbox
                                            label={`Include ${entry.item.name} on ${entry.sourceLabel}`}
                                            checked={selected}
                                            disabled={
                                                entry.reason !== null ||
                                                operation.isPending
                                            }
                                            onChange={(checked) =>
                                                setExcluded((current) => {
                                                    const next = new Set(current);
                                                    if (checked) next.delete(key);
                                                    else next.add(key);
                                                    return next;
                                                })
                                            }
                                        />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <DetailEntry
                                            name={entry.item.name}
                                            description={entry.sourceLabel}
                                            accessory={
                                                <Badge
                                                    tone={
                                                        selected ? "positive" : "neutral"
                                                    }
                                                >
                                                    {selected
                                                        ? "Included"
                                                        : "Not included"}
                                                </Badge>
                                            }
                                        >
                                            <DetailFacts
                                                items={[
                                                    {
                                                        label: "Installed",
                                                        value: updateVersion(
                                                            entry.item,
                                                            "installed"
                                                        ),
                                                    },
                                                    {
                                                        label: "Available",
                                                        value: updateVersion(
                                                            entry.item,
                                                            "available"
                                                        ),
                                                    },
                                                ]}
                                            />
                                        </DetailEntry>
                                        {entry.reason && (
                                            <p className="mt-1 text-xs text-primary-400">
                                                {entry.reason}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            );
                        }}
                    />
                </div>
            )}
        </ConfirmDialog>
    );
}
