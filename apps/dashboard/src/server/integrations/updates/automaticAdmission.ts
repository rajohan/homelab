import type { UpdateControl, UpdatePolicy } from "@homelab/contracts/updates";
import type { SQL } from "bun";

import { enqueueJob } from "../../jobs/queue";
import type { JobExecution, JobHandler } from "../../jobs/types";
import { type UpdateTarget, updateTargetRevision } from "./configuration";
import { freshAptObservation, readUpdateReport } from "./inventory";
import { readUpdatePolicies } from "./policies";
import { matchesUpdateTarget, updateControl } from "./selection";

/** Explain whether the current automatic policy permits this exact update.
 * @param policy - Effective target policy after configuration checks.
 * @param control - Reviewed candidate and its change classification.
 * @returns A reason to skip the candidate or null to allow it.
 */
export function automaticReason(
    policy: UpdatePolicy | undefined,
    control: UpdateControl
): string | null {
    if (!policy?.enabled) return "automatic updates off";
    if (!control.allowed) return control.reason ?? "installation unavailable";
    switch (control.change) {
        case "digest": {
            return policy.allowDigest ? null : "digest-only updates off";
        }
        case "major": {
            return "major upgrade";
        }
        case "unknown": {
            return "versions cannot be safely compared";
        }
        default: {
            return null;
        }
    }
}

/** Admit verified candidates, serialized per target and deduplicated across discovery runs.
 * @param client - Dashboard operation state.
 * @param context - Active worker claim used to commit each admission.
 * @param targets - Allowed targets for the entire scan or one APT continuation.
 * @param sourceIds - Sources whose fresh reports belong to this pass.
 * @param installers - Registered, integration-only installation handlers.
 * @param continuingPolicy - Original automatic APT policy version for a host continuation.
 */
export async function admitAutomaticUpdates(
    client: SQL,
    context: JobExecution,
    targets: readonly UpdateTarget[],
    sourceIds: Iterable<string>,
    installers: readonly JobHandler[],
    continuingPolicy?: number
): Promise<void> {
    const policies = await readUpdatePolicies(client, targets);
    let queued = 0;
    let waiting = 0;
    let available = 0;
    const examples: string[] = [];
    const skip = (name: string, reason: string) => {
        if (examples.length < 4)
            examples.push(`${name.replaceAll(/\p{Cc}/gu, " ").slice(0, 55)}: ${reason}`);
    };
    for (const source of sourceIds) {
        context.signal.throwIfAborted();
        const report = await readUpdateReport(client, source);
        if (!report) continue;
        const sourceTargets = targets.filter((target) => target.source === source);
        for (const item of report.items) {
            if (
                item.status !== "available" ||
                (continuingPolicy !== undefined && item.kind !== "os")
            )
                continue;
            available++;
            const target = sourceTargets.find((candidate) =>
                matchesUpdateTarget(candidate, item)
            );
            if (!target) {
                skip(item.name, "no configured installer");
                continue;
            }
            const policy = policies.find((candidate) => candidate.target === target.id);
            const control = updateControl(target, report, item);
            const reason =
                (continuingPolicy !== undefined && policy?.version !== continuingPolicy
                    ? "policy changed"
                    : null) ??
                automaticReason(policy, control) ??
                (target.driver.kind === "apt" && !freshAptObservation(report)
                    ? "package observation expired"
                    : null) ??
                (queued >= 50 ? "queue limit reached" : null);
            if (reason || !policy) {
                skip(item.name, reason ?? "automatic updates off");
                continue;
            }
            const installer = installers.find(
                (candidate) => candidate.definition.key === `updates.install.${target.id}`
            )!;
            const candidateKey = new Bun.CryptoHasher("sha256")
                .update(
                    JSON.stringify([
                        updateTargetRevision(target),
                        item.id,
                        item.available,
                        item.availableImage,
                    ])
                )
                .digest("hex");
            if (
                !(await context.commit(async (transaction) => {
                    // Serialize admission with operator policy writes so a
                    // disable committed during checking cannot enqueue work.
                    if (continuingPolicy !== undefined) {
                        const [schedule] = await transaction<
                            { enabled: boolean }[]
                        >`SELECT enabled FROM job_schedules WHERE action='updates.automatic' FOR SHARE`;
                        if (schedule?.enabled === false) {
                            skip(item.name, "automatic schedule paused");
                            return;
                        }
                    }
                    const [currentPolicy] = await transaction<
                        {
                            enabled: boolean;
                            version: number;
                            configuration: string;
                        }[]
                    >`SELECT enabled,version,configuration FROM update_policies WHERE target=${target.id} FOR SHARE`;
                    if (
                        !currentPolicy?.enabled ||
                        currentPolicy.version !== policy.version ||
                        currentPolicy.configuration !== updateTargetRevision(target)
                    ) {
                        skip(item.name, "policy changed");
                        return;
                    }
                    // Failed/expired automatic runs are not silently retried for the same candidate.
                    const key = `automatic-update:${target.id}:${candidateKey}`;
                    const [existing] = await transaction<
                        { id: string }[]
                    >`SELECT id FROM job_runs WHERE idempotency_key=${key}`;
                    if (existing) {
                        skip(item.name, "already attempted");
                        return;
                    }
                    const [active] = await transaction<
                        { id: string }[]
                    >`SELECT id FROM job_runs WHERE action=${installer.definition.key} AND state IN ('queued','running') LIMIT 1`;
                    if (active) {
                        if (target.driver.kind === "apt") waiting++;
                        else skip(item.name, "another installation is queued or running");
                        return;
                    }
                    await enqueueJob(
                        transaction,
                        installer.definition,
                        "system:automatic-updates",
                        key,
                        {
                            target: target.id,
                            item: item.id,
                            revision: control.revision,
                            automatic: true,
                            policyVersion: policy.version,
                        },
                        `Update ${item.name}`
                    );
                    queued += 1;
                }, true))
            )
                throw new Error("Automatic update admission lost its claim");
        }
    }
    const skipped = available - queued - waiting;
    const summary = [
        `${available} available`,
        `${queued} queued`,
        ...(waiting ? [`${waiting} waiting for host installation`] : []),
        `${skipped} skipped`,
    ].join(" · ");
    await context.reportProgress(
        [
            summary,
            ...examples,
            ...(skipped > examples.length
                ? [`and ${skipped - examples.length} more`]
                : []),
        ]
            .join(" · ")
            .slice(0, 500)
    );
}
