import type { MiraRunSummary } from "@homelab/contracts/mira";
import type { TableSort } from "@homelab/contracts/tableSort";
import {
    Badge,
    DataTable,
    DropdownMenu,
    type DropdownMenuAction,
    formatDateTime,
    type InfiniteScrollContinuation,
} from "@homelab/ui";
import { Link } from "@tanstack/react-router";
import { ListChecks, MessageSquare, Square } from "lucide-react";
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
                        width: "w-16",
                        mobile: "footer-actions",
                        render: (run) => {
                            const actions: DropdownMenuAction[] = [
                                {
                                    id: "details",
                                    label: "Details",
                                    icon: ListChecks,
                                    onSelect: () => setSelected(run.id),
                                },
                            ];
                            if (run.conversationAvailable)
                                actions.push({
                                    id: "chat",
                                    label: "Open chat",
                                    icon: MessageSquare,
                                    renderLink: (content) => (
                                        <Link
                                            to="/mira/$conversationId"
                                            params={{
                                                conversationId: run.conversationId,
                                            }}
                                        >
                                            {content}
                                        </Link>
                                    ),
                                });
                            if (["queued", "running"].includes(run.state))
                                actions.push({
                                    id: "stop",
                                    label:
                                        run.cancelRequested || stoppingId === run.id
                                            ? "Stopping"
                                            : "Stop",
                                    icon: Square,
                                    danger: true,
                                    disabled:
                                        run.cancelRequested || stoppingId === run.id,
                                    onSelect: () => onStop(run.id),
                                });
                            return (
                                <div className="flex justify-end">
                                    <DropdownMenu
                                        label={`Actions for ${run.title}, ${formatDateTime(run.createdAt)}`}
                                        actions={actions}
                                    />
                                </div>
                            );
                        },
                    },
                ]}
            />
            {selected && (
                <MiraRunDetails id={selected} onClose={() => setSelected(null)} />
            )}
        </>
    );
}
