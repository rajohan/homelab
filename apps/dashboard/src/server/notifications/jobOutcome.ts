import type { NotificationSeverity } from "@homelab/contracts/notifications";

import type { Transaction } from "../database/connection";
import { publishNotification } from "./publish";

/**
 * Record final job outcomes in the same transaction as settlement, including expired claims.
 * @param transaction - The fenced settlement transaction.
 * @param id - The exact completed job; queued retries never emit final notifications.
 * @returns Completion without duplicating an already recorded outcome.
 */
export async function notifyJobOutcome(
    transaction: Transaction,
    id: string
): Promise<void> {
    const [run] = await transaction<
        { label: string; state: string; requested_by: string; action: string }[]
    >`SELECT label, state, requested_by, action FROM job_runs WHERE id = ${id}`;
    if (!run || ["queued", "running"].includes(run.state)) return;
    const failed = ["failed", "timed_out"].includes(run.state);
    if (!failed && run.requested_by === "system:scheduler") return;
    const successSeverity = run.state === "succeeded" ? "success" : "info";
    const severity: NotificationSeverity = failed ? "error" : successSeverity;
    const outcome = run.state === "timed_out" ? "timed out" : run.state;
    await publishNotification(transaction, "jobs", {
        key: id,
        title: `${run.label.slice(0, 120)}: ${outcome}`,
        message: failed
            ? "The job did not complete successfully. Open Jobs to inspect its status and recorded events."
            : `The job ${outcome}. Open Jobs to inspect its recorded events.`,
        severity,
        destination: "jobs",
    });
}
