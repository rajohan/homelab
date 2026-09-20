import { jobStates } from "@homelab/contracts/operations";
import {
    Badge,
    Button,
    Card,
    ConfirmDialog,
    DataTable,
    ErrorNotice,
    LoadingState,
    SectionHeader,
    queryRefresh,
    formatDateTime,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Cpu, Pause, Play } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Display durable worker control, all queue counts and the live process inventory.
 * @returns A pause control that stops new claims without interrupting active work.
 */
export function WorkerPanel() {
    const [confirmation, setConfirmation] = useState<{
        version: number;
        paused: boolean;
    }>();
    const query = useQuery({
        queryKey: ["operations", "worker"],
        queryFn: ({ signal }) => api.worker.overview.query(undefined, { signal }),
        ...queryRefresh("fast"),
        retry: false,
    });
    const toggle = useOperation((input: { version: number; paused: boolean }, signal) =>
        api.worker.setPaused.mutate(input, { signal })
    );
    const data = query.data;
    const online = data?.workers.filter((worker) => worker.online) ?? [];
    const availabilityTone = online.length > 0 ? "positive" : "warning";
    const availabilityLabel = online.length > 0 ? "Running" : "Offline";
    return (
        <Card className="@container">
            <div className="grid gap-4 @min-[48rem]:grid-cols-[minmax(0,1fr)_auto]">
                <SectionHeader
                    title="Worker"
                    description="Pause new work while current jobs finish. The setting is shared by all workers and survives restarts."
                    icon={Cpu}
                    compactActions
                    badge={
                        data && (
                            <Badge
                                tone={data.control.paused ? "neutral" : availabilityTone}
                            >
                                {data.control.paused ? "Paused" : availabilityLabel}
                            </Badge>
                        )
                    }
                />
                <div className="col-span-full space-y-4">
                    {query.isPending && <LoadingState label="Loading worker status…" />}
                    {query.isError && <ErrorNotice error={query.error} />}
                    {data && (
                        <>
                            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                                {jobStates.map((state) => (
                                    <div
                                        key={state}
                                        className="rounded-lg border border-primary-700 bg-primary-900/40 p-3"
                                    >
                                        <dt className="text-xs text-primary-400 capitalize">
                                            {state.replaceAll("_", " ")}
                                        </dt>
                                        <dd className="mt-1 text-2xl font-semibold tabular-nums">
                                            {data.counts.find(
                                                (count) => count.state === state
                                            )?.count ?? 0}
                                        </dd>
                                    </div>
                                ))}
                            </dl>
                            {data.control.paused && (
                                <p className="rounded-lg border border-primary-700 bg-primary-900/40 p-3 text-sm text-primary-300">
                                    Scheduled submissions and new job claims are paused.
                                    Manual requests stay queued until you resume. Running
                                    jobs finish normally.
                                </p>
                            )}
                            <DataTable
                                label="Workers"
                                compact
                                rows={data.workers}
                                getKey={(worker) => worker.id}
                                columns={[
                                    {
                                        id: "id",
                                        label: "Worker",
                                        mobile: "title",
                                        render: (worker) => worker.id.slice(0, 8),
                                    },
                                    {
                                        id: "state",
                                        label: "Status",
                                        render: (worker) => {
                                            const availability = worker.online
                                                ? "Online"
                                                : "Offline";
                                            return (
                                                <Badge
                                                    tone={
                                                        worker.online
                                                            ? "positive"
                                                            : "neutral"
                                                    }
                                                >
                                                    {worker.draining
                                                        ? "Stopped"
                                                        : availability}
                                                </Badge>
                                            );
                                        },
                                    },
                                    {
                                        id: "capacity",
                                        label: "Active / capacity",
                                        render: (worker) =>
                                            `${worker.active} / ${worker.capacity}`,
                                    },
                                    {
                                        id: "version",
                                        label: "Version",
                                        render: (worker) => worker.version,
                                    },
                                    {
                                        id: "heartbeat",
                                        label: "Last heartbeat",
                                        render: (worker) =>
                                            formatDateTime(worker.heartbeatAt),
                                    },
                                ]}
                            />
                        </>
                    )}
                </div>
                {data && (
                    <Button
                        size="sm"
                        variant="secondary"
                        className="w-full @min-[48rem]:col-start-2 @min-[48rem]:row-start-1 @min-[48rem]:w-auto @min-[48rem]:self-start"
                        aria-label={
                            data.control.paused ? "Resume worker" : "Pause worker"
                        }
                        onClick={() => setConfirmation(data.control)}
                    >
                        {data.control.paused ? (
                            <Play size={16} aria-hidden="true" />
                        ) : (
                            <Pause size={16} aria-hidden="true" />
                        )}
                        {data.control.paused ? "Resume" : "Pause"}
                    </Button>
                )}
            </div>
            {confirmation && (
                <ConfirmDialog
                    title={confirmation.paused ? "Resume worker?" : "Pause worker?"}
                    description={
                        confirmation.paused
                            ? "Queued jobs can start again. Missed schedule occurrences are combined into at most one run per job."
                            : "Pause new work across all workers. Running jobs will finish; queued jobs will wait. An intentional pause is not an error."
                    }
                    confirmLabel={confirmation.paused ? "Resume worker" : "Pause worker"}
                    variant="primary"
                    onClose={() => setConfirmation(undefined)}
                    onConfirm={async () => {
                        await toggle.mutateAsync({
                            version: confirmation.version,
                            paused: !confirmation.paused,
                        });
                        setConfirmation(undefined);
                    }}
                />
            )}
        </Card>
    );
}
