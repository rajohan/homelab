import type { UpdateItem, UpdateReport } from "@homelab/contracts/updates";
import type { TransactionSQL } from "bun";

import type { UpdateTarget } from "../updates/configuration";
import { deploymentHosts, type ReleaseDeploymentTarget } from "./deploymentConfiguration";
import type {
    DeploymentObservation,
    DeploymentPlan,
    DeploymentReceipt,
} from "./deploymentProtocol";

/**
 * Capture the inventoried identities that predate an admitted release.
 * @param transaction - Admission transaction under the queue lock.
 * @param target - Deployment recipe with its optional independent Auth host.
 * @param connections - Connections binding those hosts to their inventory sources.
 * @param plan - Validated preflight observations with the exact Docker names.
 * @returns Immutable identity pairs from the affected raw and resolved rows only.
 */
export async function readDeploymentInventory(
    transaction: TransactionSQL,
    target: ReleaseDeploymentTarget,
    connections: readonly UpdateTarget[],
    plan: DeploymentPlan
): Promise<NonNullable<DeploymentPlan["inventory"]>> {
    const inventory: NonNullable<DeploymentPlan["inventory"]> = [];
    for (const host of deploymentHosts(target)) {
        const source = connections.find((entry) => entry.id === host.connection)?.source;
        const expected = host === target.auth ? plan.authExpected : plan.expected;
        if (!source || !expected) continue;
        const names = Object.values(expected.containers).flatMap((item) =>
            item.name ? [item.name] : []
        );
        if (names.length === 0) continue;
        const rows = await transaction<NonNullable<DeploymentPlan["inventory"]>>`
            SELECT key AS snapshot,value->>'capturedAt' AS "capturedAt",
                   item->>'name' AS name,item->>'id' AS id,item->>'installed' AS installed
            FROM operation_snapshots CROSS JOIN LATERAL jsonb_array_elements(value->'items') AS expanded(item)
            WHERE key IN (${`updates:${source}`}, ${`updates.resolved:${source}`})
              AND item->>'kind'='container' AND item->>'name'=ANY(${transaction.array(names, "TEXT")})`;
        inventory.push(...rows);
    }
    return inventory;
}

/**
 * Reconcile only containers proven replaced by a validated deployment receipt.
 * @param transaction - The same fenced transaction that records deployment completion.
 * @param source - Inventory source of the configured deployment connection.
 * @param expected - Exact container identities approved before replacement.
 * @param receipt - Successful host receipt already checked against the release and service recipe.
 * @param inventory - Identities held at admission, permitting older observations to converge.
 * @returns Completion after raw and resolved inventory reflect the observed installation.
 */
export async function recordDeploymentInventory(
    transaction: TransactionSQL,
    source: string,
    expected: DeploymentObservation,
    receipt: DeploymentReceipt,
    inventory: DeploymentPlan["inventory"] = []
): Promise<void> {
    if (receipt.state !== "succeeded" || !receipt.containers || !receipt.version) return;
    for (const key of [`updates:${source}`, `updates.resolved:${source}`]) {
        // Neither publisher nor host clocks establish replacement order. Exact immutable
        // container/image identities below fence newer replacements, including clock skew.
        const [row] = await transaction<{ value: UpdateReport }[]>`
            SELECT value FROM operation_snapshots WHERE key=${key} FOR UPDATE`;
        if (!row) continue;
        const admission = inventory.filter(
            (entry) => entry.snapshot === key && entry.capturedAt === row.value.capturedAt
        );
        const items = row.value.items.map((item) => {
            if (item.kind !== "container") return item;
            // The host may have recreated the service several times since its last publication.
            // Only its original, uniquely named row may join the verified before/after identities.
            const unchanged =
                admission.some(
                    (entry) =>
                        entry.name === item.name &&
                        entry.id === item.id &&
                        entry.installed === item.installed
                ) &&
                !row.value.items.some(
                    (other) =>
                        other !== item &&
                        other.kind === "container" &&
                        other.name === item.name
                );
            const match = Object.entries(expected.containers).find(
                ([service, before]) => {
                    const after = receipt.containers![service];
                    return (
                        after &&
                        ((item.id === `docker:${before.id}` &&
                            item.installed === before.imageId) ||
                            (item.id === `docker:${after.id}` &&
                                item.installed === after.imageId) ||
                            (unchanged &&
                                before.name === item.name &&
                                after.name === item.name))
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
                captured_at=GREATEST(captured_at,now())
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
