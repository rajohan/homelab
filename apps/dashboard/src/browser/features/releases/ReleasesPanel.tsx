import {
    Badge,
    Button,
    Card,
    ErrorNotice,
    LoadingState,
    SectionHeader,
    buttonStyles,
    queryRefresh,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { PackageCheck, Tag } from "lucide-react";

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
    const verification = release?.value.verified ? "Verified release" : "Not verified";
    return (
        <Card className="@container space-y-4">
            <SectionHeader
                title="Homelab release"
                description="Current app versions and the latest published release."
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
                            <dt className="text-xs text-primary-400">Dashboard</dt>
                            <dd className="font-medium wrap-anywhere">
                                {data.dashboard}
                            </dd>
                        </div>
                        <div className="space-y-2 rounded-lg border border-primary-700 bg-primary-950/40 p-4">
                            <dt className="text-xs text-primary-400">Workers</dt>
                            <dd className="font-medium wrap-anywhere">
                                {data.workers.length > 0
                                    ? data.workers
                                          .map(
                                              (worker) =>
                                                  `${worker.version}${worker.online ? "" : " (not responding)"}`
                                          )
                                          .join(", ")
                                    : "No workers available"}
                            </dd>
                        </div>
                        <div className="space-y-2 rounded-lg border border-primary-700 bg-primary-950/40 p-4">
                            <dt className="text-xs text-primary-400">Auth</dt>
                            <dd className="font-medium wrap-anywhere">
                                {data.auth.length > 0
                                    ? data.auth
                                          .map(
                                              (auth) =>
                                                  `${auth.version}${auth.stale ? " (outdated)" : ""}`
                                          )
                                          .join("; ")
                                    : "Version unavailable"}
                            </dd>
                        </div>
                    </dl>
                    {release ? (
                        <div className="space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm">
                            <SectionHeader
                                title={`Published ${release.value.version}`}
                                icon={Tag}
                                badge={
                                    <Badge
                                        tone={
                                            release.fresh && release.value.verified
                                                ? "positive"
                                                : "warning"
                                        }
                                    >
                                        {release.fresh ? verification : "Status outdated"}
                                    </Badge>
                                }
                                actions={
                                    <a
                                        className={buttonStyles({
                                            variant: "secondary",
                                            size: "sm",
                                        })}
                                        href={release.value.url}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        View release
                                    </a>
                                }
                            />
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
                        </div>
                    ) : (
                        <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                            {data.configured
                                ? "No release information yet. Refresh to check."
                                : "Release checks are not configured."}
                        </p>
                    )}
                </>
            )}
        </Card>
    );
}
