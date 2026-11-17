import type { MiraQuota } from "@homelab/contracts/mira";
import { formatDateTime } from "@homelab/ui";
import { useSyncExternalStore } from "react";

function subscribeClock(notify: () => void) {
    const timer = setInterval(notify, 10_000);
    return () => clearInterval(timer);
}
function readClock() {
    return Math.floor(Date.now() / 10_000) * 10_000;
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
    const stale =
        !fresh || !quota || (now ?? clock) - Date.parse(quota.observedAt) >= 90_000;
    const windows = quota?.windows ?? [];
    return (
        <details className="border-b border-primary-700 px-4 py-2 text-xs text-primary-400">
            <summary className="cursor-pointer">
                ChatGPT quota ·{" "}
                {!stale && windows.length > 0
                    ? `${Math.round(Math.min(...windows.map((entry) => entry.remainingPercent)))}% left`
                    : "quota unavailable"}
            </summary>
            <div className="mt-2 space-y-1">
                {windows.length === 0 ? (
                    <p>Quota unavailable</p>
                ) : (
                    <>
                        {stale && <p>Last reported values · refresh unavailable</p>}
                        {windows.map((window) => (
                            <div key={window.label}>
                                <p>
                                    {window.label}: {Math.round(window.remainingPercent)}%
                                    remaining
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
                                        style={{ width: `${window.remainingPercent}%` }}
                                    />
                                </div>
                                {window.resetsAt && (
                                    <p>Resets {formatDateTime(window.resetsAt)}</p>
                                )}
                            </div>
                        ))}
                        <p>Updated {formatDateTime(quota?.observedAt ?? "")}</p>
                    </>
                )}
            </div>
        </details>
    );
}
