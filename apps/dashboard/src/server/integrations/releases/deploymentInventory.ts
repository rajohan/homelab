import type { UpdateItem, UpdateReport } from "@homelab/contracts/updates";
import type { TransactionSQL } from "bun";

import type { DeploymentObservation, DeploymentReceipt } from "./deploymentProtocol";

/**
 * Reconcile only containers proven replaced by a validated deployment receipt.
 * @param transaction - The same fenced transaction that records deployment completion.
 * @param source - Inventory source of the configured deployment connection.
 * @param expected - Exact container identities approved before replacement.
 * @param receipt - Successful host receipt already checked against the release and service recipe.
 * @returns Completion after raw and resolved inventory reflect the observed installation.
 */
export async function recordDeploymentInventory(
    transaction: TransactionSQL,
    source: string,
    expected: DeploymentObservation,
    receipt: DeploymentReceipt
): Promise<void> {
    if (receipt.state !== "succeeded" || !receipt.containers || !receipt.version) return;
    for (const key of [`updates:${source}`, `updates.resolved:${source}`]) {
        const [row] = await transaction<{ value: UpdateReport }[]>`
            SELECT value FROM operation_snapshots WHERE key=${key} FOR UPDATE`;
        if (!row || Date.parse(row.value.capturedAt) > receipt.updatedAt * 1000) continue;
        const items = row.value.items.map((item) => {
            if (item.kind !== "container") return item;
            const match = Object.entries(expected.containers).find(
                ([service, before]) => {
                    const after = receipt.containers![service];
                    return (
                        after &&
                        ((item.id === `docker:${before.id}` &&
                            item.installed === before.imageId) ||
                            (item.id === `docker:${after.id}` &&
                                item.installed === after.imageId))
                    );
                }
            );
            if (!match) return item;
            const after = receipt.containers![match[0]]!;
            // A newer registry result may have arrived while this release was installing.
            const newer = preserveCandidate(
                item,
                after.image,
                after.imageId,
                receipt.version!
            );
            return {
                ...item,
                id: `docker:${after.id}`,
                installed: after.imageId,
                installedVersion: receipt.version,
                image: after.image,
                pinned: true,
                ...(newer
                    ? {}
                    : {
                          available: after.imageId,
                          availableVersion: receipt.version,
                          availableImage: after.image,
                          candidateVerified: true,
                      }),
                status: newer ? ("available" as const) : ("current" as const),
            };
        });
        if (items.every((item, index) => item === row.value.items[index])) continue;
        // Preserve unrelated observation ages while rejecting delayed pre-deployment reports.
        await transaction`UPDATE operation_snapshots
            SET value=${JSON.stringify({ ...row.value, items })}::text::jsonb,
                captured_at=GREATEST(captured_at,to_timestamp(${receipt.updatedAt}))
            WHERE key=${key}`;
    }
}

function preserveCandidate(
    item: UpdateItem,
    image: string,
    imageId: string,
    version: string
): boolean {
    if (
        !item.candidateVerified ||
        !item.availableImage ||
        item.availableImage === image ||
        item.available === imageId
    )
        return false;
    if (!item.availableVersion) return true;
    try {
        return Bun.semver.order(item.availableVersion, version) >= 0;
    } catch {
        // OCI labels may contain branch names. Do not let one block completion or hide a distinct candidate.
        return true;
    }
}
