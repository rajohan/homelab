import type { MiraRun } from "@homelab/contracts/mira";
import { Badge } from "@homelab/ui";
import { Brain, LoaderCircle, MessageSquare, Wrench } from "lucide-react";
import { useState } from "react";

import type { ChatDisplaySettings } from "./chatDisplay";

/**
 * Present observed work stages and redacted durable tool receipts beneath the current reply.
 * @returns Compact status and expandable tool outcomes, without fabricated progress.
 */
export function ChatActivity({
    run,
    tools,
    display,
}: {
    readonly run: MiraRun | null;
    readonly tools: { id: string; tool: string; state: string; message: string | null }[];
    readonly display: ChatDisplaySettings;
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
    const showStatus = display.showActivity && (active || display.keepActivity);
    const showTools = display.showTools && tools.length > 0;
    if (!showStatus && !showTools) return null;
    return (
        <div className="space-y-2 text-xs text-primary-400">
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
            {showTools && (
                <details
                    className="rounded-lg border border-primary-700 bg-primary-900/40"
                    open={expanded}
                    onToggle={(event) => setExpanded(event.currentTarget.open)}
                >
                    <summary className="cursor-pointer px-3 py-2 text-primary-300">
                        {tools.length} {tools.length === 1 ? "tool" : "tools"}
                    </summary>
                    <ul className="max-h-48 space-y-2 overflow-y-auto border-t border-primary-700 px-3 py-2">
                        {tools.map((tool) => (
                            <li key={tool.id} className="space-y-1">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <span className="min-w-0 wrap-break-word">
                                        {tool.tool
                                            .replace(/^mira_/, "")
                                            .replaceAll("_", " ")}
                                    </span>
                                    <Badge>{toolStates[tool.state] ?? "Unknown"}</Badge>
                                </div>
                                {tool.message && <p>{tool.message}</p>}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}
