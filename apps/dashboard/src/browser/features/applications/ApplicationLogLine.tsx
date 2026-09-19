import type { LogEntry } from "@homelab/contracts/logs";
import { Badge, formatDateTime } from "@homelab/ui";

/**
 * Display untrusted log text as escaped, wrapped content with consistent timestamps.
 * @returns One readable log record without interpreting HTML, terminal escapes or links.
 */
export function ApplicationLogLine({ entry }: { readonly entry: LogEntry }) {
    let tone: "danger" | "warning" | "neutral" = "neutral";
    if (["error", "fatal", "critical"].includes(entry.level)) tone = "danger";
    else if (["warn", "warning"].includes(entry.level)) tone = "warning";
    return (
        <article className="space-y-1 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-primary-400">
                <time>
                    {formatDateTime(Number(BigInt(entry.timestamp) / 1_000_000n))}
                </time>
                <Badge tone={tone}>{entry.level}</Badge>
            </div>
            <pre className="font-mono text-xs leading-5 wrap-anywhere whitespace-pre-wrap text-primary-200">
                {entry.message}
            </pre>
        </article>
    );
}
