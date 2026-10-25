import type { MiraDaytonaJob } from "@homelab/contracts/miraDaytona";
import {
    ActionGroup,
    Badge,
    Button,
    Card,
    ErrorNotice,
    Modal,
    SectionHeader,
    formatDateTime,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Cloud, File, ScrollText } from "lucide-react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import {
    daytonaTones,
    daytonaCleanupLabels,
    daytonaPhaseLabels,
} from "./daytonaPresentation";
import { MessageAttachments } from "./MessageAttachments";

/**
 * Review exact cloud execution or follow its durable status after reconnecting.
 * @returns Bounded status, logs, results and cancellation controls.
 */
export function DaytonaDetails({
    job: initial,
    onClose,
}: {
    readonly job: MiraDaytonaJob;
    readonly onClose: () => void;
}) {
    const query = useQuery({
        queryKey: ["operations", "mira", "daytona", initial.id],
        queryFn: () => api.mira.daytona.read.query({ id: initial.id }),
        initialData: initial,
        refetchInterval: 3000,
    });
    const job = initial.state === "draft" ? initial : query.data;
    const changed = initial.state === "draft" && query.data.version !== initial.version;
    const approve = useOperation(() =>
        api.mira.daytona.approve.mutate({
            id: job.id,
            version: job.version,
            contentHash: job.contentHash,
            reviewedContent: job.content,
        })
    );
    const cancel = useOperation(() =>
        api.mira.daytona.cancel.mutate({ id: job.id, version: job.version })
    );
    const busy = approve.isPending || cancel.isPending;
    const active = ["draft", "queued", "running", "needs_attention"].includes(job.state);
    return (
        <Modal
            title={job.state === "draft" ? "Review cloud job" : "Cloud job details"}
            onClose={onClose}
            size="wide"
            dismissible={!busy}
        >
            <div className="space-y-4">
                <Card className="space-y-4 bg-primary-900/40">
                    <SectionHeader
                        title={job.content.title}
                        icon={Cloud}
                        badge={
                            <Badge tone={daytonaTones[job.state]}>
                                {job.state.replaceAll("_", " ")}
                            </Badge>
                        }
                    />
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                        <div>
                            <dt className="text-primary-400">Progress</dt>
                            <dd>{daytonaPhaseLabels[job.phase] ?? "Unknown"}</dd>
                        </div>
                        <div>
                            <dt className="text-primary-400">Sandbox cleanup</dt>
                            <dd>{daytonaCleanupLabels[job.cleanup]}</dd>
                        </div>
                        {job.exitCode !== null && (
                            <div>
                                <dt className="text-primary-400">Exit code</dt>
                                <dd>{job.exitCode}</dd>
                            </div>
                        )}
                        <div>
                            <dt className="text-primary-400">Created</dt>
                            <dd>{formatDateTime(job.createdAt)}</dd>
                        </div>
                    </dl>
                    {job.cancelRequested && job.cleanup === "pending" && (
                        <p className="text-sm text-primary-300">
                            Cancellation requested. Waiting for sandbox cleanup.
                        </p>
                    )}
                    {job.message && (
                        <p className="text-sm text-primary-300">{job.message}</p>
                    )}
                    <pre className="max-h-72 overflow-auto rounded-lg border border-primary-700 bg-primary-950/40 p-3 text-sm wrap-anywhere whitespace-pre-wrap">
                        {job.content.command}
                    </pre>
                </Card>
                {job.state === "draft" && (
                    <p className="text-sm text-primary-300">
                        Start this exact command in Daytona with the selected files. Cloud
                        usage may be billed. Each sandbox has 2 CPUs, 4 GiB memory, 10 GiB
                        disk and a 15-minute lifetime. Mira allows one active sandbox and
                        four attempts per rolling 24 hours. Provider network access is
                        enabled.
                    </p>
                )}
                {(job.content.inputs.length > 0 || job.content.outputs.length > 0) && (
                    <Card className="space-y-3 bg-primary-900/40">
                        <SectionHeader title="Selected files" icon={File} />
                        <p className="text-sm wrap-anywhere text-primary-300">
                            Inputs:{" "}
                            {job.content.inputs.map((file) => file.name).join(", ") ||
                                "None"}
                        </p>
                        {job.content.inputs.length > 0 && (
                            <MessageAttachments
                                ids={job.content.inputs.map((file) => file.id)}
                            />
                        )}
                        <p className="text-sm wrap-anywhere text-primary-300">
                            Results: {job.content.outputs.join(", ") || "None"}
                        </p>
                        {job.files.length > 0 && (
                            <MessageAttachments ids={job.files.map((file) => file.id)} />
                        )}
                    </Card>
                )}
                {(job.stdout || job.stderr || job.output) && (
                    <Card className="space-y-3 bg-primary-900/40">
                        <SectionHeader title="Logs" icon={ScrollText} />
                        {(
                            [
                                ["Standard output", job.stdout],
                                ["Standard error", job.stderr],
                                ["Combined output", job.output],
                            ] as const
                        )
                            .filter(([, text]) => text)
                            .map(([label, text]) => (
                                <div key={label}>
                                    <p className="mb-2 text-xs text-primary-400">
                                        {label}
                                    </p>
                                    <pre className="max-h-72 overflow-auto rounded-lg border border-primary-700 bg-primary-950/40 p-3 text-xs wrap-anywhere whitespace-pre-wrap">
                                        {text}
                                    </pre>
                                </div>
                            ))}
                    </Card>
                )}
                {changed && (
                    <p className="text-sm text-primary-300">
                        This job changed. Close it and review the current version before
                        starting.
                    </p>
                )}
                {(query.error || approve.error || cancel.error) && (
                    <ErrorNotice error={query.error ?? approve.error ?? cancel.error} />
                )}
                <ActionGroup>
                    {job.state === "draft" && (
                        <Button
                            busy={approve.isPending}
                            disabled={busy || changed}
                            onClick={() =>
                                void approve
                                    .mutateAsync(undefined)
                                    .then(onClose)
                                    .catch(() => {})
                            }
                        >
                            Start cloud job
                        </Button>
                    )}
                    {active && !job.cancelRequested && (
                        <Button
                            variant="secondary"
                            busy={cancel.isPending}
                            disabled={busy}
                            onClick={() =>
                                void cancel
                                    .mutateAsync(undefined)
                                    .then(() => query.refetch())
                                    .catch(() => {})
                            }
                        >
                            Cancel job
                        </Button>
                    )}
                    <Button variant="secondary" onClick={onClose} disabled={busy}>
                        Close
                    </Button>
                </ActionGroup>
            </div>
        </Modal>
    );
}
