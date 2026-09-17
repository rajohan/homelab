import { PageHeader } from "@homelab/ui";

import { JobHistory } from "../features/jobs/JobHistory";
import { SchedulesPanel } from "../features/jobs/SchedulesPanel";
import { WorkerPanel } from "../features/jobs/WorkerPanel";

/**
 * Compose operational views without coupling their state or implementation.
 * @returns The jobs workspace within the shared dashboard shell.
 */
export function Jobs() {
    return (
        <div className="space-y-4">
            <PageHeader
                title="Jobs"
                description="Run background work, manage schedules and inspect outcomes."
            />
            <WorkerPanel />
            <JobHistory view="active" title="Queued and running" />
            <SchedulesPanel />
            <JobHistory />
        </div>
    );
}
