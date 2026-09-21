import type { UpdateReport } from "@homelab/contracts/updates";

import type { Transaction } from "../../database/connection";
import type { ApplicationTarget } from "../applications/configuration";
import { updateResourceKeys, type UpdateTarget } from "./configuration";
import { updateControl } from "./selection";

export interface UpdateReceiptScope {
    readonly sources: readonly string[];
    readonly targets: readonly UpdateTarget[];
}

/**
 * Limit identity reconciliation to sources explicitly bound to the installation host.
 * @param target - Installer whose verified receipt is being recorded.
 * @param targets - Deployment-owned update recipes, including same-SSH-host sources.
 * @param applications - Explicit lifecycle source bindings for alternate host addresses.
 * @returns Sources and recipes eligible for receipt reconciliation, never inferred from report contents.
 */
export function updateReceiptScope(
    target: UpdateTarget,
    targets: readonly UpdateTarget[],
    applications: readonly ApplicationTarget[]
): UpdateReceiptScope {
    const sources = new Set([target.source]);
    if (target.driver.kind === "docker") {
        for (const other of targets)
            if (
                other.driver.kind === "docker" &&
                other.host.toLowerCase() === target.host.toLowerCase()
            )
                sources.add(other.source);
        for (const application of applications) {
            const bound = application.updateSources ?? [application.id];
            if (bound.includes(target.source))
                for (const source of bound) sources.add(source);
        }
    }
    return {
        sources: [...sources].toSorted(),
        targets: targets.filter((other) => sources.has(other.source)),
    };
}

/**
 * Lease every explicit alias whose stored identities can be changed by this receipt.
 * @param scope - Host-bound recipes derived from deployment configuration.
 * @returns Unique source and physical-host locks shared with peer update jobs.
 */
export function updateReceiptResourceKeys(scope: UpdateReceiptScope): string[] {
    return [...new Set(scope.targets.flatMap(updateResourceKeys))].toSorted();
}

/**
 * Carry exact identity-only receipts into queued sibling batches from the same confirmation.
 * @param transaction - Still-owned result transaction holding the queue lock.
 * @param runId - Producer job; individual jobs never rewrite another confirmation.
 * @param source - Explicitly bound report source being reconciled.
 * @param before - Locked resolved report before applying verified recreation identities.
 * @param after - Same report after reconciliation, with versions and observation time preserved.
 * @param targets - Deployment-owned recipes used to verify both confirmation revisions.
 * @returns After updating only matching queued sibling entries; original admission fingerprint stays immutable.
 */
export async function remapPendingUpdateBatches(
    transaction: Transaction,
    runId: string,
    source: string,
    before: UpdateReport & { checkedAt: string },
    after: UpdateReport & { checkedAt: string },
    targets: readonly UpdateTarget[]
): Promise<void> {
    type Payload = {
        items: { target: string; item: string; revision: string }[];
        [key: string]: unknown;
    };
    const peers = await transaction<{ id: string; payload: Payload }[]>`
        SELECT peer.id, peer.payload FROM job_runs own JOIN job_runs peer ON peer.id <> own.id
        WHERE own.id=${runId} AND own.action LIKE 'updates.batch.%'
          AND peer.action LIKE 'updates.batch.%' AND peer.state='queued'
          AND peer.payload->>'source'=${source} AND peer.requested_by=own.requested_by
          AND peer.payload->>'requestId'=own.payload->>'requestId'
          AND peer.payload->>'revision'=own.payload->>'revision'
          AND (peer.payload->>'scope') IS NOT DISTINCT FROM (own.payload->>'scope')
          AND peer.resource_keys && ARRAY(SELECT key FROM unnest(own.resource_keys) AS resource(key) WHERE key LIKE 'host:%')
        ORDER BY peer.id FOR UPDATE OF peer`;
    for (const peer of peers) {
        let changed = false;
        const items = peer.payload.items.map((entry) => {
            const target = targets.find(
                (candidate) =>
                    candidate.id === entry.target &&
                    candidate.source === source &&
                    candidate.driver.kind === "docker"
            );
            const index = before.items.findIndex((item) => item.id === entry.item);
            const previous = before.items[index],
                current = after.items[index];
            if (
                !target ||
                !previous ||
                !current ||
                previous.id === current.id ||
                JSON.stringify({ ...previous, id: current.id }) !==
                    JSON.stringify(current)
            )
                return entry;
            const oldControl = updateControl(target, before, previous);
            const newControl = updateControl(target, after, current);
            if (
                !oldControl.allowed ||
                oldControl.revision !== entry.revision ||
                !newControl.allowed
            )
                return entry;
            changed = true;
            return { ...entry, item: current.id, revision: newControl.revision };
        });
        if (changed)
            // The original plan/fingerprint still identifies the user's admission.
            // Only an identity-only transition proven by that plan's sibling may move it.
            await transaction`UPDATE job_runs SET payload=${JSON.stringify({ ...peer.payload, items })}::text::jsonb WHERE id=${peer.id}`;
    }
}
