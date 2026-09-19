import type { SQL } from "bun";
import * as v from "valibot";

import { auditOperation } from "../operations/audit";
import { commitClaim } from "./claims";
import type { ClaimedJob } from "./types";

const progressMessage = v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(500),
    v.regex(/^[^\p{Cc}]+$/u)
);

/**
 * Publish job-neutral progress atomically under the active lease and cancellation fence.
 * @param client - The operational database, never an identity database.
 * @param run - The worker's exact current claim.
 * @param text - Code-owned status text, never errors, secrets or raw provider responses.
 * @returns Completion after the status update; consecutive duplicates are ignored and history is capped at 1,000 messages per run.
 * @throws {Error} Validation fails or the worker no longer owns this live, uncancelled run.
 */
export async function reportJobProgress(
    client: SQL,
    run: ClaimedJob,
    text: string
): Promise<void> {
    const message = v.parse(progressMessage, text);
    const owned = await commitClaim(client, run, async (transaction) => {
        const updated = await transaction<
            { id: string }[]
        >`UPDATE job_runs SET message=${message} WHERE id=${run.id} AND message IS DISTINCT FROM ${message} RETURNING id`;
        if (updated.length === 0) return;
        const [count] = await transaction<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM operation_audit WHERE target=${run.id} AND action='jobs.progress'`;
        if ((count?.count ?? 0) < 1000)
            await auditOperation(
                transaction,
                "system:worker",
                "jobs.progress",
                run.id,
                message
            );
    });
    if (!owned) throw new Error("Job progress ownership changed");
}
