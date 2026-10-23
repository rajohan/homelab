import {
    Badge,
    Button,
    Card,
    ErrorNotice,
    LoadingState,
    SectionHeader,
    queryRefresh,
    formatDateTime,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { PackageCheck } from "lucide-react";

import { api } from "../../api/client";
import { useJobOperation } from "../jobs/useJobOperation";

/**
 * Separate the published Homelab release from the versions actually observed in deployment.
 * @returns Test/publication evidence and independently reported Auth, dashboard and worker versions.
 */
export function ReleasesPanel() {
    const query = useQuery({
        queryKey: ["operations", "releases"],
        queryFn: ({ signal }) => api.releases.overview.query(undefined, { signal }),
        ...queryRefresh("fast"),
        retry: false,
    });
    const refresh = useJobOperation(
        (input: { action: string; requestId: string }, signal) =>
            api.jobs.run.mutate(input, { signal })
    );
    const data = query.data;
    const release = data?.release;
    return (
        <Card className="@container space-y-4">
            <SectionHeader
                title="Homelab release"
                description="Published releases and independently deployed application versions."
                icon={PackageCheck}
                actions={
                    <Button
                        variant="secondary"
                        disabled={!data?.configured || refresh.isPending}
                        onClick={() =>
                            void refresh
                                .mutateAsync({
                                    action: "homelab.release",
                                    requestId: crypto.randomUUID(),
                                })
                                .catch(() => {})
                        }
                    >
                        Refresh release
                    </Button>
                }
            />
            {query.isPending && <LoadingState label="Loading release status…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {refresh.isError && <ErrorNotice error={refresh.error} />}
            {data && (
                <>
                    <dl className="grid gap-3 text-sm @min-[48rem]:grid-cols-3">
                        <div className="space-y-2 rounded-lg border border-primary-700 bg-primary-950/40 p-4">
                            <dt className="text-xs text-primary-400">
                                Dashboard serving this request
                            </dt>
                            <dd className="font-medium wrap-anywhere">
                                {data.dashboard}
                            </dd>
                        </div>
                        <div className="space-y-2 rounded-lg border border-primary-700 bg-primary-950/40 p-4">
                            <dt className="text-xs text-primary-400">Workers</dt>
                            <dd className="wrap-anywhere">
                                {data.workers.length > 0
                                    ? data.workers
                                          .map(
                                              (worker) =>
                                                  `${worker.version} (${worker.online ? "responding" : "not responding"})`
                                          )
                                          .join(", ")
                                    : "No recent worker registration"}
                            </dd>
                        </div>
                        <div className="space-y-2 rounded-lg border border-primary-700 bg-primary-950/40 p-4">
                            <dt className="text-xs text-primary-400">
                                Auth observations
                            </dt>
                            <dd className="wrap-anywhere">
                                {data.auth.length > 0
                                    ? data.auth
                                          .map(
                                              (auth) =>
                                                  `${auth.version} — ${auth.name}${auth.stale ? " (stale)" : ""}; checked ${formatDateTime(auth.capturedAt)}`
                                          )
                                          .join("; ")
                                    : "No matching published image observation"}
                            </dd>
                        </div>
                    </dl>
                    {release ? (
                        <div className="space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                                <a
                                    className="font-medium underline"
                                    href={release.value.url}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    Published {release.value.version}
                                </a>
                                <Badge
                                    tone={
                                        release.fresh && release.value.verified
                                            ? "positive"
                                            : "warning"
                                    }
                                >
                                    {release.fresh
                                        ? `Release tests: ${release.value.tests}`
                                        : "Release check is stale"}
                                </Badge>
                            </div>
                            <p className="text-primary-400">
                                {release.value.verified
                                    ? "Image manifest matches the successful release build."
                                    : "Image manifest has no matching build evidence. Publication is not verified."}
                            </p>
                            {release.value.buildUrl && (
                                <p>
                                    <a
                                        className="underline"
                                        href={release.value.buildUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        View release build
                                    </a>
                                </p>
                            )}
                            <p className="text-primary-400">
                                Checked {formatDateTime(release.capturedAt)}. A verified
                                publication does not mean it has been deployed.
                            </p>
                        </div>
                    ) : (
                        <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                            {data.configured
                                ? "No verified release observation yet. Refresh to inspect the published manifest and build."
                                : "External release reporting is not configured."}
                        </p>
                    )}
                    <p className="text-sm text-primary-400">
                        Deployment remains a separate reviewed operation. This worker does
                        not replace or restart itself.
                    </p>
                </>
            )}
        </Card>
    );
}
