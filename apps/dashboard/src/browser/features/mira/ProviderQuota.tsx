import type { MiraQuota } from "@homelab/contracts/mira";
import { ActivityPanel, formatDateTime, Popover } from "@homelab/ui";
import { Gauge } from "lucide-react";
import { useSyncExternalStore } from "react";

function subscribeClock(notify: () => void) {
    const timer = setInterval(notify, 10_000);
    return () => clearInterval(timer);
}
function readClock() {
    return Math.floor(Date.now() / 10_000) * 10_000;
}

function windowDuration(label: string) {
    const hours = /(?:^| · )(\d+(?:\.\d+)?)h$/.exec(label)?.[1];
    if (!hours) return null;
    return Number(hours) >= 24 && Number(hours) % 24 === 0
        ? `${Number(hours) / 24}d`
        : `${hours}h`;
}

/** Show ChatGPT-reported allowance with freshness and explicit missing-data states.
 * @returns Compact quota windows that do not imply that model access is guaranteed.
 */
export function ProviderQuota({
    quotas,
    fresh,
    now,
}: {
    readonly quotas: MiraQuota[];
    readonly fresh: boolean;
    readonly now?: number;
}) {
    const clock = useSyncExternalStore(subscribeClock, readClock, readClock);
    const quota = quotas.find((entry) => entry.provider === "chatgpt");
    const observed = Date.parse(quota?.observedAt ?? "");
    const stale =
        !fresh || !Number.isFinite(observed) || (now ?? clock) - observed >= 90_000;
    const windows = quota?.windows ?? [];
    const available = !stale && windows.length > 0;
    const remaining = available
        ? Math.round(Math.min(...windows.map((entry) => entry.remainingPercent)))
        : null;
    const durations = windows.map((entry) => windowDuration(entry.label));
    const paired =
        available &&
        windows.length === 2 &&
        durations.every(Boolean) &&
        durations[0] !== durations[1] &&
        windows[0]?.label.split(" · ")[0] === windows[1]?.label.split(" · ")[0];
    const onlyDuration = windows.length === 1 ? durations[0] : null;
    const periodPrefix = onlyDuration ? `${onlyDuration} · ` : "";
    const compact =
        remaining === null ? "Quota unavailable" : `${periodPrefix}${remaining}% left`;
    const summary = paired
        ? windows
              .map(
                  (entry, index) =>
                      `${durations[index]} · ${Math.round(entry.remainingPercent)}% left`
              )
              .join(", ")
        : compact;
    return (
        <Popover
            label={`ChatGPT quota · ${summary}`}
            triggerStyle="label"
            layout="feed"
            panelClassName="w-[min(21rem,calc(100vw-1rem))]"
            trigger={
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-300">
                    <Gauge aria-hidden="true" size={14} />
                    <span className={paired ? "@min-[34rem]/chat-header:hidden" : ""}>
                        {compact}
                    </span>
                    {paired && (
                        <span className="hidden items-center gap-2.5 @min-[34rem]/chat-header:inline-flex">
                            {windows.map((entry, index) => (
                                <span
                                    key={entry.label}
                                    className="flex items-baseline gap-1"
                                >
                                    <span className="text-primary-400">
                                        {durations[index]}
                                    </span>
                                    <span className="tabular-nums">
                                        {Math.round(entry.remainingPercent)}%
                                    </span>
                                </span>
                            ))}
                        </span>
                    )}
                </span>
            }
        >
            {({ close }) => (
                <ActivityPanel title="ChatGPT quota" icon={Gauge} onClose={close}>
                    <div className="space-y-3 text-xs text-primary-300">
                        {windows.length === 0 ? (
                            <p>Quota unavailable</p>
                        ) : (
                            <>
                                {stale && (
                                    <p>Last reported values · refresh unavailable</p>
                                )}
                                {windows.map((window) => (
                                    <div key={window.label}>
                                        <p className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                                            <span className="min-w-0 wrap-break-word">
                                                {window.label.replace(
                                                    /\d+(?:\.\d+)?h$/,
                                                    (period) =>
                                                        windowDuration(window.label) ??
                                                        period
                                                )}
                                            </span>
                                            <span className="font-semibold text-primary-100 tabular-nums">
                                                {Math.round(window.remainingPercent)}%
                                                left
                                            </span>
                                        </p>
                                        <div className="my-1 h-2 overflow-hidden rounded-full bg-primary-800">
                                            <meter
                                                aria-label={`ChatGPT ${window.label} remaining`}
                                                min={0}
                                                max={100}
                                                value={window.remainingPercent}
                                                className="sr-only"
                                            />
                                            <div
                                                aria-hidden="true"
                                                className="h-full rounded-full bg-accent-400"
                                                style={{
                                                    width: `${window.remainingPercent}%`,
                                                }}
                                            />
                                        </div>
                                        {window.resetsAt && (
                                            <p>
                                                Resets {formatDateTime(window.resetsAt)}
                                            </p>
                                        )}
                                    </div>
                                ))}
                            </>
                        )}
                    </div>
                </ActivityPanel>
            )}
        </Popover>
    );
}
