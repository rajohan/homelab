import { formatDateTime, ReadingBar } from "@homelab/ui";
import { CircleCheck, CircleHelp, TriangleAlert } from "lucide-react";

import { OverviewLink } from "./OverviewLink";
import { overviewPriority } from "./overviewPriority";
import type { OverviewReadings } from "./useOverviewReadings";

/** Summarize the current priority alongside observed backup coverage.
 * @returns A linked operational headline and the latest successful backup time.
 */
export function PrioritySummary({
    readings: r,
}: {
    readonly readings: OverviewReadings;
}) {
    const healthy = r.backupRows.filter((row) => row.state === "healthy").length;
    const priority = overviewPriority(r);
    const Icon = { warning: TriangleAlert, clear: CircleCheck, unknown: CircleHelp }[
        priority.tone
    ];
    const toneColor = {
        warning: "text-amber-300",
        clear: "text-emerald-300",
        unknown: "text-primary-300",
    }[priority.tone];
    const lastSuccess = r.backupRows
        .flatMap((b) => (b.lastSuccessAt ? [b.lastSuccessAt] : []))
        .toSorted()
        .at(-1);
    return (
        <section
            aria-label="Operational priority"
            className="grid gap-4 border-y border-primary-700 bg-primary-800/65 px-4 py-5 sm:px-6 @min-[44rem]/overview:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]"
        >
            <div className="min-w-0">
                <div className="flex items-start gap-3">
                    <Icon
                        size={22}
                        aria-hidden="true"
                        className={`mt-1 shrink-0 ${toneColor}`}
                    />
                    <h2 className="text-xl font-semibold tracking-tight wrap-anywhere sm:text-2xl">
                        {priority.title}
                    </h2>
                </div>
                <p className="mt-2 text-sm wrap-anywhere text-primary-300">
                    {priority.detail}
                </p>
                <OverviewLink to={priority.to}>{priority.action}</OverviewLink>
            </div>
            <div className="min-w-0 border-t border-primary-700 pt-3 @min-[44rem]/overview:self-center @min-[44rem]/overview:border-t-0 @min-[44rem]/overview:border-l @min-[44rem]/overview:py-1 @min-[44rem]/overview:pl-6">
                <h3 className="text-sm font-semibold">Backup protection</h3>
                <p className="mt-1 text-sm text-primary-200">
                    {r.protection
                        ? `${r.backupRows.length} tasks · ${r.issueBackups.length} need attention`
                        : "Current status unavailable"}
                </p>
                {r.backupRows.length > 0 && (
                    <div className="mt-2">
                        <ReadingBar
                            percent={(healthy * 100) / r.backupRows.length}
                            tone="positive"
                        />
                        <p className="mt-1 text-xs text-primary-400">
                            {healthy} of {r.backupRows.length} healthy
                        </p>
                    </div>
                )}
                <p className="mt-1 text-xs text-primary-400">
                    {lastSuccess
                        ? "Most recent success · " + formatDateTime(lastSuccess)
                        : "No current success timestamp"}
                </p>
            </div>
        </section>
    );
}
