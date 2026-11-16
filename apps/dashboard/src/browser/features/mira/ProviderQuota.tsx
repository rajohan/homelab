import type { MiraQuota } from "@homelab/contracts/mira";
import { formatDateTime } from "@homelab/ui";

/** Show provider-reported allowance with freshness and explicit missing-data states.
 * @returns Compact quota windows that do not imply that model access is guaranteed.
 */
export function ProviderQuota({
    quotas,
    fresh,
    now,
}: {
    readonly quotas: MiraQuota[];
    readonly fresh: boolean;
    readonly now: number;
}) {
    return (
        <details className="border-b border-primary-700 px-4 py-2 text-xs text-primary-400">
            <summary className="cursor-pointer">
                Provider quota ·{" "}
                {(["chatgpt", "synthetic"] as const)
                    .map((provider) => {
                        const quota = quotas.find((entry) => entry.provider === provider);
                        const valid =
                            fresh && quota && now - Date.parse(quota.observedAt) < 90_000;
                        return `${provider === "chatgpt" ? "ChatGPT" : "Synthetic"}: ${valid && quota.windows.length > 0 ? `${Math.round(Math.min(...quota.windows.map((entry) => entry.remainingPercent)))}% left` : "unavailable"}`;
                    })
                    .join(" · ")}
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {(["chatgpt", "synthetic"] as const).map((provider) => {
                    const quota = quotas.find((entry) => entry.provider === provider);
                    const stale =
                        !fresh || !quota || now - Date.parse(quota.observedAt) >= 90_000;
                    return (
                        <div key={provider} className="space-y-1">
                            <p className="font-medium text-primary-200">
                                {provider === "chatgpt" ? "ChatGPT" : "Synthetic"}
                            </p>
                            {(quota?.windows.length ?? 0) === 0 ? (
                                <p>Quota unavailable</p>
                            ) : (
                                <>
                                    {stale && (
                                        <p>Last reported values · refresh unavailable</p>
                                    )}
                                    {quota?.windows.map((window) => (
                                        <div key={window.label}>
                                            <p>
                                                {window.label}:{" "}
                                                {Math.round(window.remainingPercent)}%
                                                remaining
                                            </p>
                                            <meter
                                                aria-label={`${provider} ${window.label} remaining`}
                                                min={0}
                                                max={100}
                                                value={window.remainingPercent}
                                                className="w-full"
                                            />
                                            {window.resetsAt && (
                                                <p>
                                                    Resets{" "}
                                                    {formatDateTime(window.resetsAt)}
                                                </p>
                                            )}
                                        </div>
                                    ))}
                                    <p>
                                        Updated {formatDateTime(quota?.observedAt ?? "")}
                                    </p>
                                </>
                            )}
                        </div>
                    );
                })}
            </div>
        </details>
    );
}
