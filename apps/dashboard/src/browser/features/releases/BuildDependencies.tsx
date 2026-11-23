import {
    Badge,
    Button,
    Card,
    ConfirmDialog,
    DataTable,
    ErrorNotice,
    LoadingState,
    queryRefresh,
    SectionHeader,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { PackageSearch } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useJobOperation } from "../jobs/useJobOperation";
import { useOperation } from "../operations/useOperation";

const statusLabels = {
    available: "Update available",
    current: "Current",
    unknown: "Check unavailable",
    stale: "Outdated check",
} as const;

/**
 * Show automatically checked source dependencies alongside the existing software updater.
 * @returns Manifest pins, available upstream versions and source-check freshness.
 */
export function BuildDependencies() {
    const query = useQuery({
        queryKey: ["operations", "releases", "dependencies"],
        queryFn: ({ signal }) => api.releases.dependencies.query(undefined, { signal }),
        ...queryRefresh("normal"),
        retry: false,
    });
    const refresh = useJobOperation(
        (input: { action: string; requestId: string }, signal) =>
            api.jobs.run.mutate(input, { signal })
    );
    const [selection, setSelection] = useState<{
        dependency: string;
        name: string;
        pinned: string;
        available: string;
    }>();
    const prepare = useOperation(
        (input: { dependency: string; pinned: string; available: string }, signal) =>
            api.mira.tasks.prepareDependency.mutate(input, { signal })
    );
    const snapshot = query.data?.snapshot;
    const fresh = Boolean(snapshot?.fresh && !query.isError);
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Homelab source dependencies"
                description="Checked hourly. Updates are incorporated through a reviewed Homelab release."
                icon={PackageSearch}
                badge={
                    snapshot && !fresh && <Badge tone="warning">Status outdated</Badge>
                }
                actions={
                    <Button
                        variant="secondary"
                        disabled={!query.data?.configured || refresh.isPending}
                        onClick={() =>
                            void refresh
                                .mutateAsync({
                                    action: "homelab.dependencies",
                                    requestId: crypto.randomUUID(),
                                })
                                .then(() => query.refetch())
                                .catch(() => {})
                        }
                    >
                        Check updates
                    </Button>
                }
            />
            {query.isPending && <LoadingState label="Loading dependency updates…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {refresh.isError && <ErrorNotice error={refresh.error} />}
            {snapshot ? (
                <DataTable
                    label="Homelab source dependencies"
                    compact
                    rows={snapshot.value.items}
                    getKey={(item) => item.id}
                    columns={[
                        {
                            id: "name",
                            label: "Dependency",
                            mobile: "title",
                            sortValue: (item) => item.name,
                            render: (item) => (
                                <a
                                    className="text-accent-300 underline underline-offset-4"
                                    href={item.url}
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    {item.name}
                                </a>
                            ),
                        },
                        {
                            id: "pinned",
                            label: "In this release",
                            sortValue: (item) => item.pinned,
                            render: (item) => item.pinned,
                        },
                        {
                            id: "available",
                            label: "Upstream",
                            sortValue: (item) => item.available,
                            render: (item) =>
                                fresh ? (item.available ?? "Unavailable") : "Unknown",
                        },
                        {
                            id: "status",
                            label: "Status",
                            sortValue: (item) => (fresh ? item.status : null),
                            render: (item) => (
                                <Badge
                                    tone={
                                        fresh && item.status === "current"
                                            ? "positive"
                                            : "warning"
                                    }
                                >
                                    {statusLabels[fresh ? item.status : "stale"]}
                                </Badge>
                            ),
                        },
                        ...(fresh &&
                        snapshot.value.items.some((row) => row.status === "available")
                            ? [
                                  {
                                      id: "review",
                                      label: "Review",
                                      render: (
                                          item: (typeof snapshot.value.items)[number]
                                      ) =>
                                          item.status === "available" &&
                                          item.available && (
                                              <Button
                                                  size="sm"
                                                  variant="secondary"
                                                  onClick={() =>
                                                      setSelection({
                                                          dependency: item.id,
                                                          name: item.name,
                                                          pinned: item.pinned,
                                                          available: item.available,
                                                      })
                                                  }
                                              >
                                                  Prepare with Mira
                                              </Button>
                                          ),
                                  },
                              ]
                            : []),
                    ]}
                />
            ) : (
                query.data &&
                !query.isError && (
                    <p className="text-sm text-primary-400">
                        {query.data.configured
                            ? "Waiting for the first dependency check."
                            : "Release checks are not configured."}
                    </p>
                )
            )}
            {prepare.isSuccess && (
                <output className="text-sm text-primary-300">
                    Preparation task created.{" "}
                    <a className="text-accent-300 underline" href="/tasks">
                        View Mira tasks
                    </a>
                </output>
            )}
            {selection && (
                <ConfirmDialog
                    title={`Prepare ${selection.name} ${selection.available}?`}
                    description={`Mira will prepare the update from ${selection.pinned} to ${selection.available} in a branch for your review.`}
                    confirmLabel="Start Mira task"
                    onClose={() => setSelection(undefined)}
                    onConfirm={async () => {
                        const { dependency, pinned, available } = selection;
                        await prepare.mutateAsync({ dependency, pinned, available });
                        setSelection(undefined);
                    }}
                />
            )}
        </Card>
    );
}
