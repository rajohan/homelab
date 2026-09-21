import type { JobSummary } from "@homelab/contracts/operations";
import type { TableSort } from "@homelab/contracts/tableSort";
import {
    IconButton,
    DataTable,
    ConfirmDialog,
    formatDateTime,
    type InfiniteScrollContinuation,
} from "@homelab/ui";
import { Square } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { formatJobActor } from "./formatJobActor";
import { JobStatus } from "./JobStatus";

/**
 * Render the same run columns and cancellation semantics in every history view.
 * @returns A responsive table with run details and explicit cancellation actions.
 */
export function JobRunTable({
    rows,
    onSelect,
    continuation,
    sort,
    onSortChange,
}: {
    readonly rows: readonly JobSummary[];
    readonly onSelect: (id: string) => void;
    readonly continuation?: InfiniteScrollContinuation;
    readonly sort?: TableSort | null;
    readonly onSortChange?: (sort: TableSort | null) => void;
}) {
    const [stopping, setStopping] = useState<JobSummary>();
    const cancel = useOperation((id: string, signal) =>
        api.jobs.cancel.mutate({ id }, { signal })
    );
    return (
        <>
            <DataTable
                label="Job runs"
                compact
                rowAction={{
                    label: (run) =>
                        `Open details for ${run.label}, ${formatDateTime(run.createdAt)}`,
                    onSelect: (run) => onSelect(run.id),
                }}
                rows={rows}
                {...(sort === undefined ? {} : { sort })}
                {...(onSortChange ? { onSortChange } : {})}
                {...(continuation ? { continuation } : {})}
                getKey={(run) => run.id}
                columns={[
                    {
                        id: "job",
                        sortValue: (row) => row.label,
                        label: "Job",
                        mobile: "title",
                        render: (run) => run.label,
                    },
                    {
                        id: "state",
                        sortValue: (row) => row.state,
                        label: "Status",
                        render: (run) => <JobStatus state={run.state} />,
                    },
                    {
                        id: "size",
                        sortValue: (row) => row.resourceClass,
                        label: "Work size",
                        render: (run) => run.resourceClass,
                    },
                    {
                        id: "attempt",
                        sortValue: (row) => row.attempt,
                        label: "Attempt",
                        render: (run) => `${run.attempt} / ${run.attemptLimit}`,
                    },
                    {
                        id: "time",
                        sortValue: (row) => row.createdAt,
                        label: "Queued",
                        render: (run) => formatDateTime(run.createdAt),
                    },
                    {
                        id: "actor",
                        sortValue: (row) => formatJobActor(row.requestedBy),
                        label: "Requested by",
                        mobile: "wide",
                        render: (run) => formatJobActor(run.requestedBy),
                    },
                    ...(rows.some(
                        (run) => run.state === "queued" || run.state === "running"
                    )
                        ? [
                              {
                                  id: "actions",
                                  label: "Stop",
                                  hideLabel: true,
                                  width: "w-16",
                                  mobile: "actions" as const,
                                  render: (run: JobSummary) =>
                                      (run.state === "queued" ||
                                          run.state === "running") && (
                                          <IconButton
                                              icon={Square}
                                              label={
                                                  run.cancelRequested
                                                      ? "Stopping job"
                                                      : `Stop ${run.label}`
                                              }
                                              variant="danger"
                                              disabled={
                                                  run.cancelRequested || cancel.isPending
                                              }
                                              onClick={() => setStopping(run)}
                                          />
                                      ),
                              },
                          ]
                        : []),
                ]}
            />
            {stopping && (
                <ConfirmDialog
                    title="Stop this job?"
                    description={`Stop “${stopping.label}”? Queued work will be cancelled. Running work stops at its next cancellation checkpoint; completed changes are not undone.`}
                    confirmLabel="Stop job"
                    onClose={() => setStopping(undefined)}
                    onConfirm={async () => {
                        await cancel.mutateAsync(stopping.id);
                        setStopping(undefined);
                    }}
                />
            )}
        </>
    );
}
