import {
    Badge,
    Button,
    ErrorNotice,
    LoadingState,
    SectionHeader,
    queryRefresh,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useJobOperation } from "../jobs/useJobOperation";
import { useOperation } from "../operations/useOperation";
import { DeploymentDialog } from "./DeploymentDialog";

const labels: Record<string, string> = {
    waiting: "Waiting for active work",
    submitting: "Starting deployment",
    running: "Deploying",
    succeeded: "Deployed",
    failed: "Deployment failed",
    cancelled: "Cancelled",
    unknown: "Recovery required",
};
const tones: Record<string, "positive" | "warning"> = {
    succeeded: "positive",
    failed: "warning",
    unknown: "warning",
};

/**
 * Show confirmed release deployment and its durable result across dashboard restarts.
 * @returns Shared release controls with full-width actions on narrow cards.
 */
export function DeploymentPanel() {
    const query = useQuery({
        queryKey: ["operations", "deployment"],
        queryFn: ({ signal }) =>
            api.releases.deployment.overview.query(undefined, { signal }),
        ...queryRefresh("fast"),
        retry: false,
    });
    const prepare = useJobOperation(
        (input: { action: string; requestId: string }, signal) =>
            api.jobs.run.mutate(input, { signal })
    );
    const cancel = useOperation((input: { id: string }, signal) =>
        api.releases.deployment.cancel.mutate(input, { signal })
    );
    const [selected, setSelected] = useState<{
        id: string;
        label: string;
        version: string;
        revision: string;
    }>();
    const active = query.data?.history.find((entry) => entry.active);
    const run = active ?? query.data?.history[0];
    if (query.data?.targets.length === 0 && query.data.history.length === 0) return null;
    return (
        <div className="space-y-3">
            {query.isPending && <LoadingState label="Loading deployment status…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {prepare.isError && <ErrorNotice error={prepare.error} />}
            {cancel.isError && <ErrorNotice error={cancel.error} />}
            {query.data?.targets.map((target) => (
                <div
                    key={target.id}
                    className="@container/deployment space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm"
                >
                    <div className="grid items-center gap-3 @min-[40rem]/deployment:grid-cols-[minmax(0,1fr)_auto]">
                        <SectionHeader
                            icon={Rocket}
                            title={target.label}
                            description={
                                target.version
                                    ? `Release ${target.version} is ready for confirmation.`
                                    : "Prepare the current release before deployment."
                            }
                        />
                        <div className="flex w-full flex-col gap-2 @min-[40rem]/deployment:w-auto @min-[40rem]/deployment:flex-row">
                            <Button
                                variant="secondary"
                                disabled={Boolean(active) || prepare.isPending}
                                onClick={() =>
                                    void prepare
                                        .mutateAsync({
                                            action: `homelab.prepare.${target.id}`,
                                            requestId: crypto.randomUUID(),
                                        })
                                        .catch(() => {})
                                }
                            >
                                Prepare release
                            </Button>
                            <Button
                                disabled={
                                    Boolean(active) ||
                                    !target.revision ||
                                    !target.version ||
                                    query.isError
                                }
                                onClick={() => {
                                    if (target.revision && target.version)
                                        setSelected({
                                            ...target,
                                            revision: target.revision,
                                            version: target.version,
                                        });
                                }}
                            >
                                Deploy release
                            </Button>
                        </div>
                    </div>
                </div>
            ))}
            {run && (
                <output className="block space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm">
                    <SectionHeader
                        icon={Rocket}
                        title={`Release ${run.version}`}
                        badge={
                            <Badge tone={tones[run.state] ?? "neutral"}>
                                {labels[run.state] ?? "Checking deployment"}
                            </Badge>
                        }
                        actions={
                            run.state === "waiting" ? (
                                <Button
                                    variant="secondary"
                                    disabled={cancel.isPending}
                                    onClick={() =>
                                        void cancel
                                            .mutateAsync({ id: run.id })
                                            .catch(() => {})
                                    }
                                >
                                    Cancel deployment
                                </Button>
                            ) : undefined
                        }
                    />
                    {run.message && <p className="text-primary-300">{run.message}</p>}
                </output>
            )}
            {selected && (
                <DeploymentDialog
                    target={selected}
                    onClose={() => setSelected(undefined)}
                />
            )}
        </div>
    );
}
