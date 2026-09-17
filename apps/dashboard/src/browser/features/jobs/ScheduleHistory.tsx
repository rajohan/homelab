import type { ScheduleSummary } from "@homelab/contracts/operations";
import { Modal } from "@homelab/ui";

import { JobHistory } from "./JobHistory";

/**
 * Inspect one schedule's run history in the shared, scrollable table.
 * @returns A wide history modal without duplicate schedule details or nested scroll regions.
 */
export function ScheduleHistory({
    schedule,
    onClose,
}: {
    readonly schedule: ScheduleSummary;
    readonly onClose: () => void;
}) {
    return (
        <Modal title="History" description={schedule.label} onClose={onClose} size="wide">
            <JobHistory action={schedule.action} view="all" embedded />
        </Modal>
    );
}
