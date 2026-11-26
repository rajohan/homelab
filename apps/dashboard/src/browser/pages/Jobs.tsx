import { PageHeader, PageSections } from "@homelab/ui";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";
import * as v from "valibot";

import { JobHistory } from "../features/jobs/JobHistory";
import { jobLocation } from "../features/jobs/jobLocation";
import { RunDetailDialog } from "../features/jobs/RunDetailDialog";
import { SchedulesPanel } from "../features/jobs/SchedulesPanel";
import { WorkerPanel } from "../features/jobs/WorkerPanel";
import { CodeLibrary } from "../features/mira/CodeLibrary";
import { DaytonaJobs } from "../features/mira/DaytonaJobs";
import { MiraRunHistory } from "../features/mira/MiraRunHistory";

/**
 * Compose operational views without coupling their state or implementation.
 * @returns The jobs workspace within the shared dashboard shell.
 */
export function Jobs() {
    const { run } = v.parse(jobLocation, useSearch({ from: "/jobs" }));
    const navigate = useNavigate({ from: "/jobs" });
    return (
        <div className="space-y-4">
            <PageHeader
                icon={ListChecks}
                title="Jobs"
                description="Run background work, manage schedules and inspect outcomes."
            />
            <PageSections
                deferBelowFold
                label="Jobs sections"
                sections={[
                    { id: "workers", label: "Workers", content: <WorkerPanel /> },
                    {
                        id: "queue",
                        label: "Queue",
                        // Anchor the page to the section being read as active jobs come and go.
                        className: "[overflow-anchor:none]",
                        content: <JobHistory view="active" title="Queued and running" />,
                    },
                    { id: "schedules", label: "Schedules", content: <SchedulesPanel /> },
                    { id: "history", label: "Job history", content: <JobHistory /> },
                    { id: "mira-runs", label: "Mira runs", content: <MiraRunHistory /> },
                    {
                        id: "code-jobs",
                        label: "Code jobs",
                        content: <DaytonaJobs />,
                    },
                    {
                        id: "code-changes",
                        label: "Code changes",
                        content: <CodeLibrary />,
                    },
                ]}
            />
            {run && (
                <RunDetailDialog
                    id={run}
                    onClose={() =>
                        void navigate({
                            to: "/jobs",
                            search: {},
                            hash: true,
                            hashScrollIntoView: false,
                            resetScroll: false,
                            replace: true,
                        })
                    }
                />
            )}
        </div>
    );
}
