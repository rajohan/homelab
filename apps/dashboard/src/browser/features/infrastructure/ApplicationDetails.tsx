import type { ApplicationMetric } from "@homelab/contracts/infrastructure";

import { applicationDirectory } from "../applications/applicationDirectory";
import { ApplicationInspector } from "../applications/ApplicationInspector";
import { useApplicationControl } from "../applications/useApplicationControl";

/** Open the same inspector from a host or Overview, including controls for a unique managed match.
 * @returns Monitoring history and all available container details for the selected service.
 */
export function ApplicationDetails({
    application,
    applications,
    capturedAt,
    cores,
    stale = false,
    onClose,
}: {
    readonly application: ApplicationMetric;
    readonly applications: readonly ApplicationMetric[];
    readonly capturedAt: string;
    readonly cores: number | null;
    readonly stale?: boolean;
    readonly onClose: () => void;
}) {
    const control = useApplicationControl();
    const entry = applicationDirectory(applications, control.containers).find(
        (row) => row.metric?.id === application.id
    );
    return (
        entry && (
            <ApplicationInspector
                entry={entry}
                capturedAt={capturedAt}
                cores={cores}
                stale={stale}
                available={control.available(application.host)}
                logsAvailable={control.logsAvailable(application.host)}
                onClose={onClose}
            />
        )
    );
}
