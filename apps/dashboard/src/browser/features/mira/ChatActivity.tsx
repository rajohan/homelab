import type { MiraRun } from "@homelab/contracts/mira";
import { Badge, type InfiniteScrollContinuation, MarkdownText } from "@homelab/ui";
import {
    Brain,
    ChevronRight,
    LoaderCircle,
    MessageSquare,
    NotebookPen,
    Wrench,
} from "lucide-react";

import { ActivityFeed } from "./ActivityFeed";
import { ChatActivityDisclosure } from "./ChatActivityDisclosure";
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
    if (!run) return null;
    const active = ["queued", "running"].includes(run.state);
    const phase = run.activity?.phase;
    const phases = {
        thinking: "Thinking…",
        replying: "Writing reply…",
        tool: "Using a tool…",
        starting: "Starting…",
        connecting: "Connecting to ChatGPT…",
        preparing: "Preparing context…",
        compacting: "Compacting context…",
        working: "Working…",
    };
    let label =
        run.state === "needs_attention"
            ? "Needs attention"
            : run.state.charAt(0).toUpperCase() + run.state.slice(1);
    if (active) label = phases[phase ?? "working"];
    if (run.state === "queued") label = run.message ?? "Waiting for Mira…";
    if (run.cancelRequested && active) label = "Stopping…";
    const icons = {
        thinking: Brain,
        replying: MessageSquare,
        tool: Wrench,
        starting: LoaderCircle,
        connecting: LoaderCircle,
        preparing: LoaderCircle,
        compacting: LoaderCircle,
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
    const showNotes =
        display.showThinking &&
        Boolean(thinking || notes?.length || noteContinuation?.error);
    if (!showStatus && !showTools && !showNotes) return null;
    return (
        <section aria-label="Run activity" className="min-w-0 space-y-1">
            {showStatus && (
                <output
                    className={
                        run.state === "running" &&
                        !run.cancelRequested &&
                        ((phase === "tool" && showTools) ||
                            (phase === "thinking" && showNotes))
                            ? "sr-only"
                            : "flex items-center gap-2 text-xs font-medium text-primary-300"
                    }
                >
                    <Icon
                        size={15}
                        aria-hidden="true"
                        className={
                            Icon === LoaderCircle
                                ? "text-accent-300 motion-safe:animate-spin"
                                : "text-accent-300"
                        }
                    />
                    {label}
                </output>
            )}
            {(showNotes || showTools) && (
                <div className="min-w-0 divide-y divide-primary-700 overflow-hidden rounded-lg border border-primary-700 bg-surface-heading">
                    {showNotes && (
                        <ChatActivityDisclosure
                            label="Work notes"
                            icon={NotebookPen}
                            summary={notePreview}
                        >
                            <ActivityFeed
                                count={notes?.length ?? 1}
                                continuation={noteContinuation}
                            >
                                {notes?.length ? (
                                    notes.map((note) => (
                                        <div key={note.id}>
                                            <MarkdownText>
                                                {note.message ?? ""}
                                            </MarkdownText>
                                        </div>
                                    ))
                                ) : (
                                    <MarkdownText>{thinking ?? ""}</MarkdownText>
                                )}
                            </ActivityFeed>
                        </ChatActivityDisclosure>
                    )}

                    {showTools && (
                        <ChatActivityDisclosure
                            label="Tools"
                            icon={Wrench}
                            count={toolTotal ?? tools.length}
                            summary={toolPreview}
                        >
                            <ActivityFeed
                                count={tools.length}
                                continuation={toolContinuation}
                            >
                                <ul className="space-y-0.5">
                                    {tools.map((tool) => (
                                        <li key={tool.id}>
                                            {tool.message ? (
                                                <details className="group/receipt">
                                                    <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 rounded px-1 text-xs hover:bg-primary-800/60 focus-visible:outline-2 focus-visible:outline-accent-300 [&::-webkit-details-marker]:hidden">
                                                        <ChevronRight
                                                            aria-hidden="true"
                                                            size={12}
                                                            className="shrink-0 text-primary-400 group-open/receipt:rotate-90"
                                                        />
                                                        <span className="min-w-0 flex-1 font-medium wrap-anywhere text-primary-200">
                                                            {toolLabel(tool.tool)}
                                                        </span>
                                                        <Badge
                                                            className="shrink-0 px-1.5 py-0.5"
                                                            tone={miraStatusTone(
                                                                tool.state
                                                            )}
                                                        >
                                                            {toolStates[tool.state] ??
                                                                "Unknown"}
                                                        </Badge>
                                                    </summary>
                                                    <p className="pb-1 pl-6 text-xs leading-5 wrap-anywhere text-primary-300">
                                                        {tool.message}
                                                    </p>
                                                </details>
                                            ) : (
                                                <div className="flex min-h-7 items-center justify-between gap-2 pr-1 pl-6 text-xs">
                                                    <span className="min-w-0 font-medium wrap-anywhere">
                                                        {toolLabel(tool.tool)}
                                                    </span>
                                                    <Badge
                                                        className="shrink-0 px-1.5 py-0.5"
                                                        tone={miraStatusTone(tool.state)}
                                                    >
                                                        {toolStates[tool.state] ??
                                                            "Unknown"}
                                                    </Badge>
                                                </div>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </ActivityFeed>
                        </ChatActivityDisclosure>
                    )}
                </div>
            )}
        </section>
    );
}
