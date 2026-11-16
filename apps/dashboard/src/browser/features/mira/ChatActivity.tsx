import type { MiraRun } from "@homelab/contracts/mira";
import { Badge, type InfiniteScrollContinuation, MarkdownText } from "@homelab/ui";
import { Brain, LoaderCircle, MessageSquare, Wrench } from "lucide-react";
import { useState } from "react";

import { ActivityFeed } from "./ActivityFeed";
import type { ChatDisplaySettings } from "./chatDisplay";
import { miraStatusTone } from "./statusTone";
import { toolLabel } from "./toolLabel";

/**
 * Present observed work stages and redacted durable tool receipts beneath the current reply.
 * @returns Compact status and expandable tool outcomes, without fabricated progress.
 */
export function ChatActivity({
    run,
    tools,
    display,
    toolTotal,
    toolContinuation,
    notes,
    noteContinuation,
}: {
    readonly run: MiraRun | null;
    readonly tools: { id: string; tool: string; state: string; message: string | null }[];
    readonly display: ChatDisplaySettings;
    readonly toolTotal?: number;
    readonly toolContinuation?: InfiniteScrollContinuation;
    readonly notes?: { id: string; message: string | null }[];
    readonly noteContinuation?: InfiniteScrollContinuation;
}) {
    const [expanded, setExpanded] = useState(display.expandTools);
    if (!run) return null;
    const active = ["queued", "running"].includes(run.state);
    const phase = run.activity?.phase;
    const phases = {
        thinking: "Thinking…",
        replying: "Writing reply…",
        tool: "Using a tool…",
        starting: "Starting…",
        working: "Working…",
    };
    let label =
        run.state === "needs_attention"
            ? "Needs attention"
            : run.state.charAt(0).toUpperCase() + run.state.slice(1);
    if (active) label = phases[phase ?? "working"];
    if (run.state === "queued") label = "Waiting for Mira…";
    if (run.cancelRequested && active) label = "Stopping…";
    const icons = {
        thinking: Brain,
        replying: MessageSquare,
        tool: Wrench,
        starting: LoaderCircle,
        working: LoaderCircle,
    };
    const Icon = icons[phase ?? "working"];
    const toolStates: Record<string, string> = {
        succeeded: "Completed",
        awaiting_approval: "Awaiting approval",
        approved: "Approved",
        rejected: "Rejected",
        expired: "Expired",
        unknown: "Needs review",
        running: "Running",
        failed: "Failed",
    };
    const lastTool = tools.at(-1);
    const toolPreview =
        active && run.activity?.tool
            ? `${toolLabel(run.activity.tool)} · Running`
            : `${toolLabel(lastTool?.tool ?? "")} · ${toolStates[lastTool?.state ?? ""] ?? "Unknown"}`;
    const showStatus = active;
    const thinking = display.showThinking ? run.activity?.thinking : undefined;
    const notePreview =
        (thinking || notes?.at(-1)?.message)?.split("\n").findLast(Boolean) ?? "";
    const showTools =
        display.showTools && (tools.length > 0 || Boolean(toolContinuation?.error));
    if (
        !showStatus &&
        !showTools &&
        !thinking &&
        !notes?.length &&
        !noteContinuation?.error
    )
        return null;
    return (
        <div className="space-y-1 text-xs text-primary-400">
            {display.showThinking &&
            (thinking || notes?.length || Boolean(noteContinuation?.error)) ? (
                <details className="min-w-0">
                    <summary className="cursor-pointer py-1 text-primary-300">
                        <span className="font-medium">Work notes</span>
                        <span className="ml-2 inline-block max-w-[60%] truncate align-bottom font-normal text-primary-400">
                            <MarkdownText>{notePreview}</MarkdownText>
                        </span>
                    </summary>
                    <ActivityFeed
                        count={notes?.length ?? 1}
                        continuation={noteContinuation}
                    >
                        {notes?.length ? (
                            notes.map((note) => (
                                <div key={note.id}>
                                    <MarkdownText>{note.message ?? ""}</MarkdownText>
                                </div>
                            ))
                        ) : (
                            <MarkdownText>{thinking ?? ""}</MarkdownText>
                        )}
                    </ActivityFeed>
                </details>
            ) : null}
            {showTools && (
                <details
                    className="min-w-0"
                    open={expanded}
                    onToggle={(event) => setExpanded(event.currentTarget.open)}
                >
                    <summary className="cursor-pointer py-1 text-primary-300">
                        <span className="font-medium">
                            {toolTotal ?? tools.length} tools
                        </span>
                        <span className="ml-2 inline-block max-w-[60%] truncate align-bottom font-normal text-primary-400">
                            {toolPreview}
                        </span>
                    </summary>
                    <ActivityFeed count={tools.length} continuation={toolContinuation}>
                        <ul className="space-y-2">
                            {tools.map((tool) => (
                                <li key={tool.id} className="space-y-1">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <span className="min-w-0 wrap-break-word">
                                            {toolLabel(tool.tool)}
                                        </span>
                                        <Badge tone={miraStatusTone(tool.state)}>
                                            {toolStates[tool.state] ?? "Unknown"}
                                        </Badge>
                                    </div>
                                    {tool.message && <p>{tool.message}</p>}
                                </li>
                            ))}
                        </ul>
                    </ActivityFeed>
                </details>
            )}
            {showStatus && (
                <output className="flex items-center gap-2">
                    <Icon
                        size={14}
                        aria-hidden="true"
                        className={
                            active && Icon === LoaderCircle
                                ? "motion-safe:animate-spin"
                                : undefined
                        }
                    />
                    <span>{label}</span>
                </output>
            )}
        </div>
    );
}
