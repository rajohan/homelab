import {
    type AvailableSourceUpdate,
    availableSourceUpdates,
    matchSourceUpdates,
    type PrepareSourceUpdates,
} from "@homelab/contracts/sourceDependencies";
import {
    ActionGroup,
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
import { skipToken, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
        request: PrepareSourceUpdates;
        items: AvailableSourceUpdate[];
    }>();
    const prepare = useOperation((input: PrepareSourceUpdates, signal) =>
        api.mira.tasks.prepareDependency.mutate(input, { signal })
    );
    const taskId = prepare.data?.id;
    const preparedTask = useQuery({
        queryKey: ["operations", "mira", "task", taskId, "detail"],
        queryFn: taskId
            ? ({ signal }) => api.mira.tasks.read.query({ id: taskId }, { signal })
            : skipToken,
        // The scheduler links the chat after the preparation request has returned.
        refetchInterval: ({ state }) =>
            taskId &&
            !state.data?.conversationId &&
            Date.now() - prepare.submittedAt < 60_000
                ? 5000
                : false,
    });
    const snapshot = query.data?.snapshot;
    const fresh = Boolean(snapshot?.fresh && !query.isError);
    const available =
        fresh && snapshot ? availableSourceUpdates(snapshot.value.items) : [];
    function review(items: AvailableSourceUpdate[], all: boolean) {
        const versions = items.map(({ dependency, pinned, available: version }) => ({
            dependency,
            pinned,
            available: version,
        }));
        setSelection({ request: all ? { all: versions } : versions[0]!, items });
    }
    const selectionChanged =
        selection && !matchSourceUpdates(selection.request, available);
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Homelab source dependencies"
                description="Checked hourly. Mira opens a pull request with the verified updates."
                icon={PackageSearch}
                badge={
                    snapshot && !fresh && <Badge tone="warning">Status outdated</Badge>
                }
                actions={
                    <ActionGroup>
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
                        {available.length > 0 && (
                            <Button onClick={() => review(available, true)}>
                                Prepare all ({available.length})
                            </Button>
                        )}
                    </ActionGroup>
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
                        ...(available.length > 1
                            ? [
                                  {
                                      id: "review",
                                      label: "Review",
                                      render: (
                                          item: (typeof snapshot.value.items)[number]
                                      ) => {
                                          const update = available.find(
                                              (row) => row.dependency === item.id
                                          );
                                          return (
                                              update && (
                                                  <Button
                                                      size="sm"
                                                      variant="secondary"
                                                      aria-label={`Prepare ${item.name} with Mira`}
                                                      onClick={() =>
                                                          review([update], false)
                                                      }
                                                  >
                                                      Prepare with Mira
                                                  </Button>
                                              )
                                          );
                                      },
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
            {taskId && (
                <output className="text-sm text-primary-300">
                    {preparedTask.data
                        ? `Task #${preparedTask.data.number} is ready. `
                        : "Preparation task ready. "}
                    {preparedTask.data?.conversationId ? (
                        <Link
                            className="text-accent-300 underline"
                            to="/mira/$conversationId"
                            params={{ conversationId: preparedTask.data.conversationId }}
                        >
                            Open task chat
                        </Link>
                    ) : (
                        <Link className="text-accent-300 underline" to="/tasks">
                            View tasks
                        </Link>
                    )}
                </output>
            )}
            {selection && (
                <ConfirmDialog
                    title={
                        selection.items.length === 1
                            ? `Prepare ${selection.items[0]!.name}?`
                            : `Prepare all ${selection.items.length} updates?`
                    }
                    description="Mira will verify the listed versions and open one pull request for you to review."
                    confirmLabel="Start Mira task"
                    variant="primary"
                    confirmDisabled={Boolean(selectionChanged)}
                    onClose={() => setSelection(undefined)}
                    onConfirm={async () => {
                        await prepare.mutateAsync(selection.request);
                        setSelection(undefined);
                    }}
                >
                    <ul className="divide-y divide-primary-700 rounded-lg border border-primary-700 bg-surface-card px-3">
                        {selection.items.map((item) => (
                            <li
                                key={item.dependency}
                                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-sm"
                            >
                                <span className="font-medium text-primary-100">
                                    {item.name}
                                </span>
                                <span className="text-primary-300 tabular-nums">
                                    {item.pinned}{" "}
                                    <span className="text-primary-400">to</span>{" "}
                                    {item.available}
                                </span>
                            </li>
                        ))}
                    </ul>
                    {selectionChanged && (
                        <p className="text-sm text-amber-300">
                            The available updates changed. Close this dialog and review
                            the current versions.
                        </p>
                    )}
                </ConfirmDialog>
            )}
        </Card>
    );
}
