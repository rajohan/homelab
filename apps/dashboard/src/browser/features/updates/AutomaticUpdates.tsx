import { ErrorNotice, LoadingState, queryRefresh, VirtualList } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { PolicyGroupControl } from "./PolicyGroupControl";
import { UpdatePolicyControl } from "./UpdatePolicyControl";

/**
 * Show only explicitly configured installation targets for the selected source.
 * @param props - Source currently selected in Updates.
 * @returns Independent per-target policy controls, all disabled until operator consent.
 */
export function AutomaticUpdates({
    source,
    category = "software",
}: {
    readonly source: string;
    readonly category?: "software" | "toolchains";
}) {
    const query = useQuery({
        queryKey: ["operations", "updates", "policies"],
        queryFn: ({ signal }) => api.updates.policies.query(undefined, { signal }),
        ...queryRefresh("slow"),
        retry: false,
    });
    const targets =
        query.data?.filter(
            (policy) =>
                policy.source === source && (policy.category ?? "software") === category
        ) ?? [];
    const policies = query.data ?? [];
    const hostIds = [
        ...new Set(
            policies
                .filter((policy) => policy.source === source)
                .map((policy) => policy.host)
        ),
    ];
    return (
        <section className="space-y-3" aria-label="Automatic updates">
            <h3 className="text-sm font-semibold text-primary-100">Automatic updates</h3>
            {query.isPending && <LoadingState label="Loading update policies…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {policies.length > 0 && (
                <div className="divide-y divide-primary-700 rounded-lg border border-primary-700 bg-surface-card px-4">
                    <PolicyGroupControl
                        label="All hosts"
                        host={null}
                        policies={policies}
                        disabled={query.isError}
                    />
                    {hostIds.map((host) => {
                        const peers = policies.filter((policy) => policy.host === host);
                        const label =
                            hostIds.length === 1
                                ? source.charAt(0).toUpperCase() + source.slice(1)
                                : peers.find((policy) => policy.source === source)!.label;
                        return (
                            <PolicyGroupControl
                                key={host}
                                label={label}
                                host={host}
                                policies={peers}
                                disabled={query.isError}
                            />
                        );
                    })}
                </div>
            )}
            {targets.length > 0 && (
                <VirtualList
                    label="Automatic update targets"
                    rows={targets}
                    getKey={(policy) => policy.target}
                    className="max-h-[min(26rem,50dvh)]"
                    framed
                    renderItem={(policy) => (
                        <UpdatePolicyControl policy={policy} disabled={query.isError} />
                    )}
                />
            )}
            {query.isSuccess && targets.length === 0 && (
                <p className="rounded-lg border border-primary-700 bg-surface-empty p-4 text-sm text-primary-400">
                    Update installation is not configured for this source.
                </p>
            )}
        </section>
    );
}
