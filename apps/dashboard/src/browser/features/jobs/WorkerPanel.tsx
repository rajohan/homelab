import { jobStates } from "@homelab/contracts/operations";
import {
    Badge,
    Button,
    ConfirmDialog,
    DetailEntry,
    DetailFacts,
    DetailList,
    ErrorNotice,
    formatDateTime,
    LoadingState,
    SectionPanel,
    SummaryStrip,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Cpu, Pause, Play } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { workerOverviewQuery } from "./workerOverviewQuery";

function processState(worker: { readonly draining: boolean; readonly online: boolean }) {
    if (worker.draining) return "Stopped";
    return worker.online ? "Online" : "Offline";
}

/**
 * Display durable worker control, all queue counts and the live process inventory.
 * @returns A pause control that stops new claims without interrupting active work.
 */
export function WorkerPanel() {
    const [confirmation, setConfirmation] = useState<{
        version: number;
        paused: boolean;
    }>();
    const query = useQuery(workerOverviewQuery);
    const toggle = useOperation((input: { version: number; paused: boolean }, signal) =>
        api.worker.setPaused.mutate(input, { signal })
    );
    const data = query.data;
    const online = data?.workers.filter((worker) => worker.online) ?? [];
    const availabilityTone = online.length > 0 ? "positive" : "warning";
    const availabilityLabel = online.length > 0 ? "Running" : "Offline";
    return (
        <>
            <SectionPanel
                title="Worker"
                description="Pause new work while current jobs finish. The setting is shared by all workers and survives restarts."
                icon={Cpu}
                badge={
                    data && (
                        <Badge tone={data.control.paused ? "neutral" : availabilityTone}>
                            {data.control.paused ? "Paused" : availabilityLabel}
                        </Badge>
                    )
                }
                actions={
                    data && (
                        <Button
                            size="sm"
                            variant="secondary"
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
                    )
                }
            >
                {query.isPending && <LoadingState label="Loading worker status…" />}
                {query.isError && <ErrorNotice error={query.error} />}
                {data && (
                    <>
                        <SummaryStrip
                            label="Job counts by state"
                            items={jobStates.map((state) => ({
                                label:
                                    state.charAt(0).toUpperCase() +
                                    state.slice(1).replaceAll("_", " "),
                                tone: state === "running" ? "info" : "neutral",
                                value:
                                    data.counts.find((count) => count.state === state)
                                        ?.count ?? 0,
                            }))}
                        />
                        {data.control.paused && (
                            <p className="rounded-lg border border-primary-700 bg-surface-card p-3 text-sm text-primary-300">
                                Scheduled submissions and new job claims are paused.
                                Manual requests stay queued until you resume. Running jobs
                                finish normally.
                            </p>
                        )}
                    </>
                )}
            </SectionPanel>
            {data && (
                <div className="mt-4">
                    <DetailList
                        icon={Cpu}
                        title="Worker processes"
                        rows={data.workers}
                        getKey={(worker) => worker.id}
                        sorts={[
                            { label: "Worker", value: (row) => row.id },
                            {
                                label: "Status",
                                value: (row) => processState(row),
                            },
                            { label: "Active / capacity", value: (row) => row.active },
                            { label: "Version", value: (row) => row.version },
                            { label: "Last heartbeat", value: (row) => row.heartbeatAt },
                        ]}
                        empty="No worker processes reported."
                        render={(worker) => (
                            <DetailEntry
                                name={worker.id.slice(0, 8)}
                                accessory={
                                    <Badge
                                        tone={
                                            worker.online && !worker.draining
                                                ? "positive"
                                                : "neutral"
                                        }
                                    >
                                        {processState(worker)}
                                    </Badge>
                                }
                            >
                                <DetailFacts
                                    items={[
                                        {
                                            label: "Active / capacity",
                                            value: `${worker.active} / ${worker.capacity}`,
                                        },
                                        { label: "Version", value: worker.version },
                                        {
                                            label: "Last heartbeat",
                                            value: formatDateTime(worker.heartbeatAt),
                                        },
                                    ]}
                                />
                            </DetailEntry>
                        )}
                    />
                </div>
            )}
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
        </>
    );
}
