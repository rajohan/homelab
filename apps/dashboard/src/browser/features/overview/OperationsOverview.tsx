import { InfrastructureHealth } from "./InfrastructureHealth";
import { MonitoredDirectory } from "./MonitoredDirectory";
import { OperationsSummary } from "./OperationsSummary";
import { PrioritySummary } from "./PrioritySummary";
import { RecentActivity } from "./RecentActivity";
import { useOverviewReadings } from "./useOverviewReadings";

/** Render live operational priorities, infrastructure and activity from independently refreshed domains.
 * @returns The authenticated overview with canonical detail links and explicit partial-data states.
 */
export function OperationsOverview() {
    const r = useOverviewReadings();
    return (
        <div className="@container/overview flex min-w-0 flex-col gap-4 sm:gap-5">
            <PrioritySummary readings={r} />
            <InfrastructureHealth />
            <div className="grid min-w-0 gap-4 sm:gap-5 @min-[49rem]/overview:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                <OperationsSummary readings={r} />
                <RecentActivity />
            </div>
            <MonitoredDirectory readings={r} />
        </div>
    );
}
