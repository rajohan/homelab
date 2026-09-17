import { describeSchedule } from "@homelab/contracts/operations";
import {
    Badge,
    Card,
    DataTable,
    ErrorNotice,
    LoadingState,
    SectionHeader,
    formatDateTime,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";

import { api } from "../../api/client";
import { ScheduleActions } from "./ScheduleActions";

/**
 * List registered jobs with scheduling intent, manual actions and a per-job inspector.
 * @returns A live schedule inventory; disabled schedules are neutral, not failures.
 */
export function SchedulesPanel() {
    const query = useQuery({
        queryKey: ["operations", "schedules"],
        queryFn: ({ signal }) => api.schedules.list.query(undefined, { signal }),
        refetchInterval: 5000,
        retry: false,
    });
    return (
        <>
            <Card className="space-y-4">
                <SectionHeader
                    title="Schedules"
                    description="Daily, interval or cron schedules follow the system clock. Existing host timers and OpenClaw cron remain separate."
                    icon={CalendarClock}
                />
                {query.isPending && <LoadingState label="Loading schedules…" />}
                {query.isError && <ErrorNotice error={query.error} />}
                {query.data && (
                    <DataTable
                        label="Job schedules"
                        compact
                        rows={query.data}
                        getKey={(row) => row.id}
                        columns={[
                            {
                                id: "job",
                                label: "Job",
                                mobile: "title",
                                render: (row) => row.label,
                            },
                            {
                                id: "state",
                                label: "Status",
                                render: (row) => (
                                    <Badge tone={row.enabled ? "positive" : "neutral"}>
                                        {row.enabled ? "Enabled" : "Disabled"}
                                    </Badge>
                                ),
                            },
                            {
                                id: "size",
                                label: "Work size",
                                render: (row) => row.resourceClass,
                            },
                            {
                                id: "schedule",
                                label: "Schedule",
                                render: (row) => describeSchedule(row.schedule),
                            },
                            {
                                id: "next",
                                label: "Next run",
                                render: (row) => {
                                    if (row.enabled) return formatDateTime(row.nextRunAt);
                                    return row.disabledUntil
                                        ? `Resumes ${formatDateTime(row.disabledUntil)}`
                                        : "Disabled indefinitely";
                                },
                            },
                            {
                                id: "reason",
                                label: "Disable reason",
                                mobile: "wide",
                                render: (row) => row.disableReason ?? "—",
                            },
                            {
                                id: "actions",
                                label: "Actions",
                                mobile: "actions",
                                render: (row) => <ScheduleActions schedule={row} />,
                            },
                        ]}
                    />
                )}
            </Card>
        </>
    );
}
