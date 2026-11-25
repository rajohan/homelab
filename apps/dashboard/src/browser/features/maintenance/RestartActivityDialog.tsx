import { controllerRestartMessages } from "@homelab/contracts/maintenance";
import {
    DetailFacts,
    EmptyState,
    ErrorNotice,
    formatDateTime,
    LoadingState,
    Modal,
    queryRefresh,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";

import { api } from "../../api/client";
import { RestartBatchProgress } from "./RestartBatchProgress";

/** Inspect the selected restart even after newer requests enter Worker activity.
 * @param props - Journal kind, durable operation ID, display title and dismiss action.
 * @returns Live progress or the recorded outcome of that specific restart.
 */
export function RestartActivityDialog({
    kind,
    id,
    title,
    onClose,
}: {
    readonly kind: "batch" | "controller" | "notification";
    readonly id: string;
    readonly title: string;
    readonly onClose: () => void;
}) {
    const query = useQuery({
        queryKey: ["operations", "restart-detail", kind, id],
        queryFn: async ({ signal }) => {
            if (kind !== "controller") {
                const batch =
                    kind === "notification"
                        ? await api.notifications.restartBatch.query({ id }, { signal })
                        : await api.maintenance.batchStatus.query({ id }, { signal });
                return (
                    batch && {
                        kind: "batch" as const,
                        batch,
                        active: batch.phase === "waiting" || batch.phase === "running",
                    }
                );
            }
            const controller = await api.maintenance.controllerStatus.query(
                { id },
                { signal }
            );
            return (
                controller && {
                    kind,
                    controller,
                    active:
                        controller.phase === "waiting" ||
                        controller.phase === "submitted",
                }
            );
        },
        ...queryRefresh("progress"),
        refetchInterval: (q) =>
            q.state.data?.active ? queryRefresh("progress").refetchInterval : false,
        retry: false,
    });
    const detail = query.data;
    return (
        <Modal title={title} icon={RotateCw} onClose={onClose}>
            {query.isPending && <LoadingState label="Loading restart details…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {query.isSuccess && !detail && (
                <EmptyState message="This restart is no longer available." />
            )}
            {detail?.kind === "batch" && <RestartBatchProgress batch={detail.batch} />}
            {detail?.kind === "controller" && (
                <DetailFacts
                    items={[
                        { label: "Target", value: detail.controller.label },
                        {
                            label: "Requested",
                            value: formatDateTime(detail.controller.started),
                        },
                        {
                            label: "Status",
                            value: controllerRestartMessages[detail.controller.phase],
                        },
                    ]}
                />
            )}
        </Modal>
    );
}
