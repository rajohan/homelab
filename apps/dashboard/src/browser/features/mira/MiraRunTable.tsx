import type { MiraRunSummary } from "@homelab/contracts/mira";
import type { TableSort } from "@homelab/contracts/tableSort";
import {
    Badge,
    Button,
    buttonStyles,
    DataTable,
    formatDateTime,
    type InfiniteScrollContinuation,
} from "@homelab/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { MiraRunDetails } from "./MiraRunDetails";

function runSource(run: MiraRunSummary) {
    if (run.automationName) return run.automationName;
    if (run.automationId) return "Automation";
    return run.taskId ? "Task" : "Chat";
}

import { miraStatusTone } from "./statusTone";

/**
 * Present agent runs with the same responsive table and scroll behavior as infrastructure jobs.
 * @returns Named conversations, actual outcomes and accessible actions in bounded history.
 */
export function MiraRunTable({
    rows,
    onStop,
    stoppingId,
    continuation,
    sort,
    onSortChange,
}: {
    readonly rows: readonly MiraRunSummary[];
    readonly onStop: (id: string) => void;
    readonly stoppingId: string | undefined;
    readonly continuation: InfiniteScrollContinuation;
    readonly sort?: TableSort | null;
    readonly onSortChange?: (sort: TableSort | null) => void;
}) {
    const [selected, setSelected] = useState<string | null>(null);
    return (
        <>
            <DataTable
                label="Mira runs"
                compact
                rows={rows}
                getKey={(run) => run.id}
                continuation={continuation}
                {...(onSortChange ? { sort: sort ?? null, onSortChange } : {})}
                columns={[
                    {
                        id: "conversation",
                        sortValue: (run) => run.title,
                        label: "Conversation",
                        mobile: "title",
                        render: (run) => (
                            <div className="space-y-1">
                                <p className="font-medium text-primary-100">
                                    {run.title}
                                </p>
                                <p className="text-xs text-primary-400">
                                    {runSource(run)}
                                </p>
                                {run.message && (
                                    <p className="text-xs text-primary-300">
                                        {run.message}
                                    </p>
                                )}
                            </div>
                        ),
                    },
                    {
                        id: "state",
                        sortValue: (run) => run.state,
                        label: "Status",
                        width: "w-36",
                        render: (run) => (
                            <div className="flex flex-wrap gap-1.5">
                                <Badge tone={miraStatusTone(run.state)}>
                                    <span className="capitalize">
                                        {run.cancelRequested &&
                                        ["queued", "running"].includes(run.state)
                                            ? "Stopping"
                                            : run.state.replaceAll("_", " ")}
                                    </span>
                                </Badge>
                                {run.followupResolution && (
                                    <Badge tone="info">Follow-up closed</Badge>
                                )}
                            </div>
                        ),
                    },
                    {
                        id: "time",
                        sortValue: (run) => run.createdAt,
                        label: "Queued",
                        width: "w-48",
                        render: (run) => formatDateTime(run.createdAt),
                    },
                    {
                        id: "actions",
                        label: "Actions",
                        hideLabel: true,
                        width: "w-56",
                        mobile: "footer-actions",
                        render: (run) => (
                            <div className="flex flex-wrap justify-end gap-2 @max-3xl:grid @max-3xl:grid-cols-1">
                                <Button
                                    variant="secondary"
                                    className="@max-3xl:w-full"
                                    onClick={() => setSelected(run.id)}
                                >
                                    Details
                                </Button>
                                {run.conversationAvailable && (
                                    <Link
                                        className={buttonStyles({
                                            variant: "secondary",
                                            className: "@max-3xl:w-full",
                                        })}
                                        to="/mira/$conversationId"
                                        params={{ conversationId: run.conversationId }}
                                    >
                                        Open chat
                                    </Link>
                                )}
                                {["queued", "running"].includes(run.state) && (
                                    <Button
                                        variant="secondary"
                                        className="@max-3xl:w-full"
                                        busy={stoppingId === run.id}
                                        disabled={run.cancelRequested}
                                        onClick={() => onStop(run.id)}
                                    >
                                        {run.cancelRequested ? "Stopping" : "Stop"}
                                    </Button>
                                )}
                            </div>
                        ),
                    },
                ]}
            />
            {selected && (
                <MiraRunDetails id={selected} onClose={() => setSelected(null)} />
            )}
        </>
    );
}
