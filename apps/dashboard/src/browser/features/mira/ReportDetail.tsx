import {
    ActionGroup,
    Badge,
    Button,
    buttonStyles,
    ConfirmDialog,
    ErrorNotice,
    formatDateTime,
    LoadingState,
    Markdown,
    Modal,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Archive, Trash2 } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { miraStatusTone } from "./statusTone";

/**
 * Resolve a stable report link and preserve a clear tombstone when content was removed.
 * @returns A shared scrollable report dialog with execution links and lifecycle controls.
 */
export function ReportDetail({
    id,
    onClose,
}: {
    readonly id: string;
    readonly onClose: () => void;
}) {
    const [deleting, setDeleting] = useState(false);
    const query = useQuery({
        queryKey: ["operations", "mira", "report", id],
        queryFn: () => api.mira.reports.read.query({ id }),
    });
    const report = query.data;
    const change = useOperation((action: "archive" | "restore" | "delete") => {
        if (!report) throw new Error("The report has not loaded yet.");
        return api.mira.reports.change.mutate({ id, version: report.version, action });
    });
    return (
        <Modal
            title={report?.title ?? "Report"}
            onClose={onClose}
            size="wide"
            keepTitleAccessoryInline
            titleAccessory={
                report?.outcome && (
                    <Badge tone={miraStatusTone(report.outcome)}>
                        {report.outcome.replaceAll("_", " ")}
                    </Badge>
                )
            }
        >
            {query.isPending && <LoadingState label="Loading report…" />}
            {(query.error || change.error) && (
                <ErrorNotice error={query.error ?? change.error} />
            )}
            {report && (
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <Badge>{report.kind}</Badge>
                        <Badge>{report.source}</Badge>
                        <span className="text-xs text-primary-400">
                            {formatDateTime(report.createdAt)}
                        </span>
                    </div>
                    {report.deleted ? (
                        <p className="text-sm text-primary-400">
                            The operator deleted the report content.
                        </p>
                    ) : (
                        <Markdown>{report.markdown}</Markdown>
                    )}
                    <ActionGroup>
                        {!report.deleted && (
                            <Button variant="danger" onClick={() => setDeleting(true)}>
                                <Trash2 size={16} aria-hidden="true" />
                                Delete
                            </Button>
                        )}
                        {report.conversationId && (
                            <Link
                                to="/mira/$conversationId"
                                params={{ conversationId: report.conversationId }}
                                className={buttonStyles({
                                    variant: report.deleted ? "primary" : "secondary",
                                })}
                            >
                                Open conversation and run
                            </Link>
                        )}
                        {!report.deleted && (
                            <Button
                                variant="primary"
                                busy={change.isPending}
                                onClick={() =>
                                    change.mutate(
                                        report.archivedAt ? "restore" : "archive"
                                    )
                                }
                            >
                                <Archive size={16} aria-hidden="true" />
                                {report.archivedAt ? "Restore" : "Archive"}
                            </Button>
                        )}
                    </ActionGroup>
                </div>
            )}
            {deleting && (
                <ConfirmDialog
                    title="Delete report"
                    description="Remove report content. Its link and execution audit remain available."
                    confirmLabel="Delete report"
                    onClose={() => setDeleting(false)}
                    onConfirm={async () => {
                        await change.mutateAsync("delete");
                        setDeleting(false);
                    }}
                />
            )}
        </Modal>
    );
}
