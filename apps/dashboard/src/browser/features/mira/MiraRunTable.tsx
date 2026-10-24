import type { MiraRunSummary } from "@homelab/contracts/mira";
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

const tones = {
    queued: "neutral",
    running: "neutral",
    completed: "positive",
    interrupted: "neutral",
    cancelled: "neutral",
    failed: "danger",
    needs_attention: "warning",
} as const;

function runSource(run: MiraRunSummary) {
    if (run.automationName) return run.automationName;
    if (run.automationId) return "Automation";
    return run.taskId ? "Task" : "Chat";
}

/**
 * Present agent runs with the same responsive table and scroll behavior as infrastructure jobs.
 * @returns Named conversations, actual outcomes and accessible actions in bounded history.
 */
export function MiraRunTable({
    rows,
    onStop,
    stoppingId,
    continuation,
}: {
    readonly rows: readonly MiraRunSummary[];
    readonly onStop: (id: string) => void;
    readonly stoppingId: string | undefined;
    readonly continuation: InfiniteScrollContinuation;
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
                columns={[
                    {
                        id: "conversation",
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
                        label: "Status",
                        width: "w-36",
                        render: (run) => (
                            <Badge tone={tones[run.state]}>
                                <span className="capitalize">
                                    {run.cancelRequested &&
                                    ["queued", "running"].includes(run.state)
                                        ? "Stopping"
                                        : run.state.replaceAll("_", " ")}
                                </span>
                            </Badge>
                        ),
                    },
                    {
                        id: "time",
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
                            <div className="flex flex-wrap justify-end gap-2 @max-[48rem]:grid @max-[48rem]:grid-cols-1">
                                <Button
                                    variant="secondary"
                                    className="@max-[48rem]:w-full"
                                    onClick={() => setSelected(run.id)}
                                >
                                    Details
                                </Button>
                                {run.conversationAvailable && (
                                    <Link
                                        className={buttonStyles({
                                            variant: "secondary",
                                            className: "@max-[48rem]:w-full",
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
                                        className="@max-[48rem]:w-full"
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
