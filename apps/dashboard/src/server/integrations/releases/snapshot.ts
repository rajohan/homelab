import type { SQL } from "bun";

import type { readHomelabRelease } from "./read";

/**
 * Read release evidence only for the currently configured repository and account for failed checks.
 * @param client - Operations database; this reader performs no external requests.
 * @param repository - Deployment-owned repository or undefined when disabled.
 * @returns Stored evidence with a freshness flag, or null for absent or different configuration.
 */
export async function releaseSnapshot(client: SQL, repository: string | undefined) {
    if (!repository) return null;
    const [snapshot] = await client<
        {
            value: Awaited<ReturnType<typeof readHomelabRelease>>;
            capturedAt: string;
            fresh: boolean;
        }[]
    >`SELECT value, captured_at::text AS "capturedAt", captured_at > now() - interval '20 minutes' AS fresh FROM operation_snapshots WHERE key = 'homelab.release'`;
    const [lastCheck] = await client<
        { state: string }[]
    >`SELECT state FROM job_runs WHERE action = 'homelab.release' AND state NOT IN ('queued', 'running') ORDER BY id DESC LIMIT 1`;
    if (snapshot && lastCheck && lastCheck.state !== "succeeded") snapshot.fresh = false;

    return snapshot?.value.repository === repository ? snapshot : null;
}
