import { PageHeader, PageSections } from "@homelab/ui";
import { ListChecks } from "lucide-react";

import { JobHistory } from "../features/jobs/JobHistory";
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
                        content: <JobHistory view="active" title="Queued and running" />,
                    },
                    { id: "schedules", label: "Schedules", content: <SchedulesPanel /> },
                    { id: "history", label: "Job history", content: <JobHistory /> },
                    { id: "mira-runs", label: "Mira runs", content: <MiraRunHistory /> },
                    { id: "daytona", label: "Code jobs", content: <DaytonaJobs /> },
                    { id: "code", label: "Code changes", content: <CodeLibrary /> },
                ]}
            />
        </div>
    );
}
