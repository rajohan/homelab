import type { UpdateItem, UpdateReport } from "@homelab/contracts/updates";

import type { JobExecution } from "../../jobs/types";
import { publishNotification } from "../../notifications/publish";
import type { UpdateTarget } from "./configuration";
import type { UpdateExecutor, UpdateReceipt } from "./execution";
import { recordRestartObservation } from "./restartObservation";

/** Maximum execution time for one installation, shared by individual and bulk jobs. */
export const updateTimeoutMs = 1_500_000;

async function recordResult(
    target: UpdateTarget,
    item: UpdateItem,
    receipt: UpdateReceipt,
    context: JobExecution
) {
    if (
        !(await context.commit(async (transaction) => {
            for (const key of [
                `updates:${target.source}`,
                `updates.resolved:${target.source}`,
            ]) {
                const [row] = await transaction<
                    { value: UpdateReport }[]
                >`SELECT value FROM operation_snapshots WHERE key=${key} FOR UPDATE`;
                if (!row) continue;
                const items = row.value.items.map((previous) => {
                    const replacement = receipt.recreatedContainers?.find(
                        (candidate) =>
                            previous.id === `docker:${candidate.previousId}` &&
                            previous.installed === candidate.installed
                    );
                    if (
                        replacement &&
                        target.driver.kind === "docker" &&
                        previous.kind === "container"
                    )
                        // The worker verified this exact identity's project/service,
                        // image and mounts. Compose container_name is not an identity.
                        return { ...previous, id: `docker:${replacement.containerId}` };
                    if (previous.id !== item.id || previous.installed !== item.installed)
                        return previous;
                    return {
                        ...previous,
                        installed: receipt.installed,
                        available: receipt.installed,
                        status: "current" as const,
                        ...(item.availableImage
                            ? {
                                  image: item.availableImage,
                                  availableImage: item.availableImage,
                                  pinned: true,
                              }
                            : {}),
                        ...(receipt.containerId
                            ? { id: `docker:${receipt.containerId}` }
                            : {}),
                        ...(item.availableVersion
                            ? {
                                  installedVersion: item.availableVersion,
                                  availableVersion: item.availableVersion,
                              }
                            : {}),
                    };
                });
                // Receipt time is also a publication watermark: a report collected before
                // installation must not restore the old version when it arrives late.
                await transaction`UPDATE operation_snapshots SET value=${JSON.stringify({ ...row.value, items, rebootRequired: receipt.rebootRequired, rebootObservedAt: new Date().toISOString() })}::text::jsonb, captured_at=GREATEST(captured_at, now()) WHERE key=${key}`;
            }
            const observedAt = new Date().toISOString();
            await recordRestartObservation(
                transaction,
                target.source,
                receipt.rebootRequired,
                observedAt
            );
            // Application/container updates may observe a flag left by an earlier
            // OS update. Keep the host badge current without attributing that
            // unrelated restart requirement to each successful application job.
            if (target.driver.kind === "apt" && receipt.rebootRequired)
                await publishNotification(transaction, "updates", {
                    key: `reboot:${context.runId}`,
                    title: `${target.label}: restart required`,
                    message:
                        "The update completed. A host restart is required and has not been performed automatically.",
                    severity: "warning",
                    destination: "jobs",
                });
        }))
    )
        throw new Error("Update result no longer owns its job");
}

/**
 * Apply one previously authorized candidate and persist only an exact, fenced receipt.
 * @param target - Deployment-owned recipe selected by single or batch admission.
 * @param item - Exact candidate revalidated immediately before this call.
 * @param automatic - Whether dependency policy must enforce patch/minor-only changes.
 * @param context - Current worker claim, cancellation signal and progress sink.
 * @param execute - Worker-only installation boundary or an isolated test replacement.
 * @returns Completion after the installed version and durable receipt are verified.
 */
export async function applyUpdate(
    target: UpdateTarget,
    item: UpdateItem,
    automatic: boolean,
    context: JobExecution,
    execute: UpdateExecutor
): Promise<void> {
    const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(updateTimeoutMs),
    ]);
    signal.throwIfAborted();
    if (!(await context.commit(async () => {})))
        throw new Error("Update claim expired before execution");
    const receipt = await execute(
        target,
        item,
        automatic,
        signal,
        context.reportProgress
    );
    signal.throwIfAborted();
    if (receipt.installed !== item.available)
        throw new Error("Update receipt does not match the approved version");
    await recordResult(target, item, receipt, context);
    await context.reportProgress("The installed version has been verified.");
}
