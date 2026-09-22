import {
    updateChange,
    type UpdateControl,
    type UpdateItem,
    type UpdateReport,
} from "@homelab/contracts/updates";

import type { UpdateTarget } from "./configuration";
import { updateTargetRevision } from "./configuration";
import { staleUpdateReport } from "./inventory";

/**
 * Match software to one explicit update adapter, not merely a reporting host.
 * @param target - Deployment-owned update target.
 * @param item - Source observation being considered.
 * @returns Whether this target owns this software item.
 */
export function matchesUpdateTarget(target: UpdateTarget, item: UpdateItem): boolean {
    switch (target.driver.kind) {
        case "apt": {
            return (
                item.kind === "os" &&
                /^apt:[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/.test(item.id)
            );
        }
        case "docker": {
            return item.kind === "container" && item.name === target.driver.name;
        }
        case "native": {
            return (
                item.id === target.driver.item &&
                (item.kind === "runtime" || item.kind === "application")
            );
        }
    }
}

/**
 * Fence an update confirmation to its observed versions and configured execution target.
 * @param target - Explicit target owning the observation.
 * @param report - Source report; incomplete/stale reports cannot authorize writes.
 * @param item - Exact item retained in the source report.
 * @returns Browser-safe permission state and a confirmation revision.
 */
export function updateControl(
    target: UpdateTarget,
    report: UpdateReport & { readonly checkedAt?: string | null },
    item: UpdateItem
): UpdateControl {
    let reason: string | null = null;
    if (!matchesUpdateTarget(target, item))
        reason = "This software is not owned by the selected update target.";
    else if (staleUpdateReport(report))
        reason = "Refresh the software inventory before installing an update.";
    else if (item.installationBlock) reason = item.installationBlock;
    else if (item.applicationBlock) reason = item.applicationBlock;
    else if (item.held)
        reason = "This package is held. Remove the hold on its host before updating.";
    else if (target.driver.kind === "native" && item.release !== target.driver.release)
        reason =
            "The reported release provider does not match the configured update target.";
    else if (
        target.driver.kind === "docker" &&
        (item.release !== undefined || item.imageTag !== target.driver.trackingTag)
    )
        reason =
            "The reported image channel does not match the configured update target.";
    else if (item.kind !== "os" && (!report.checkedAt || !item.candidateVerified))
        reason = "The worker must verify the available version before installation.";
    else if (item.status !== "available" || !item.available)
        reason = "No verified update is available.";
    else if (
        item.kind === "container" &&
        !/@sha256:[a-f0-9]{64}$/.test(item.availableImage ?? "")
    )
        reason = "A pinned candidate image is required before updating.";
    const revision = new Bun.CryptoHasher("sha256")
        .update(
            JSON.stringify([
                updateTargetRevision(target),
                report.capturedAt,
                item.id,
                item.name,
                item.kind,
                item.installed,
                item.available,
                item.status,
                item.held,
                item.security,
                item.image,
                item.availableImage,
                item.installedVersion,
                item.availableVersion,
                item.release,
                item.imageTag,
                item.installationBlock,
                item.applicationBlock,
                item.platform?.os,
                item.platform?.architecture,
                item.platform?.variant,
            ])
        )
        .digest("hex");
    return {
        target: target.id,
        revision,
        change: updateChange(item),
        allowed: reason === null,
        reason,
    };
}
