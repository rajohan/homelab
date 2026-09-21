import { ErrorNotice, LoadingState, VirtualList, queryRefresh } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { UpdatePolicyControl } from "./UpdatePolicyControl";

/**
 * Show only explicitly configured installation targets for the selected source.
 * @param props - Source currently selected in Updates.
 * @returns Independent per-target policy controls, all disabled until operator consent.
 */
export function AutomaticUpdates({ source }: { readonly source: string }) {
    const query = useQuery({
        queryKey: ["operations", "updates", "policies"],
        queryFn: ({ signal }) => api.updates.policies.query(undefined, { signal }),
        ...queryRefresh("slow"),
        retry: false,
    });
    const targets = query.data?.filter((policy) => policy.source === source) ?? [];
    return (
        <section className="space-y-3" aria-label="Automatic updates">
            <h3 className="text-sm font-semibold text-primary-100">Automatic updates</h3>
            {query.isPending && <LoadingState label="Loading update policies…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {targets.length > 0 && (
                <VirtualList
                    label="Automatic update targets"
                    rows={targets}
                    getKey={(policy) => policy.target}
                    className="max-h-[min(26rem,50dvh)]"
                    itemClassName="last-of-type:pb-0"
                    scrollbarGap
                    renderItem={(policy) => (
                        <UpdatePolicyControl policy={policy} disabled={query.isError} />
                    )}
                />
            )}
            {query.isSuccess && targets.length === 0 && (
                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                    Update installation is not configured for this source.
                </p>
            )}
        </section>
    );
}
