import type { UpdatePolicy } from "@homelab/contracts/updates";
import type { SQL } from "bun";

import { auditOperation } from "../../operations/audit";
import { OperationFailure } from "../../operations/errors";
import { updateTargetRevision, type UpdateTarget } from "./configuration";

/**
 * Read policy only for currently configured update targets; new or changed recipes stay off.
 * @param client - Dashboard-only database.
 * @param targets - Current deployment registry.
 * @returns Safe policy summaries without paths, recipes or SSH identities.
 */
export async function readUpdatePolicies(
    client: SQL,
    targets: readonly UpdateTarget[]
): Promise<UpdatePolicy[]> {
    const rows = await client<
        { target: string; enabled: boolean; version: number; configuration: string }[]
    >`SELECT target, enabled, version, configuration FROM update_policies`;
    return targets.map((target) => {
        const row = rows.find((policy) => policy.target === target.id);
        const changed = Boolean(
            row && row.configuration !== updateTargetRevision(target)
        );
        return {
            target: target.id,
            category:
                target.driver.kind === "native" &&
                target.driver.item.startsWith("runtime:")
                    ? "toolchains"
                    : "software",
            label: target.label,
            source: target.source,
            enabled: Boolean(row?.enabled && !changed),
            version: row?.version ?? 0,
            configurationChanged: changed,
        };
    });
}

/**
 * Save an explicitly confirmed automatic patch/minor policy with concurrent-edit protection.
 * @param client - Dashboard database.
 * @param target - Current deployment-owned update target.
 * @param actor - Verified human operator.
 * @param input - Desired enabled state and last observed version.
 * @returns Completion after the policy and audit entry commit together.
 */
export async function writeUpdatePolicy(
    client: SQL,
    target: UpdateTarget,
    actor: string,
    input: { enabled: boolean; version: number }
): Promise<void> {
    await client.begin(async (transaction) => {
        const rows = await transaction<
            { version: number }[]
        >`INSERT INTO update_policies (target, enabled, version, configuration) SELECT ${target.id}, ${input.enabled}, 1, ${updateTargetRevision(target)} WHERE ${input.version} = 0 ON CONFLICT (target) DO NOTHING RETURNING version`;
        if (!rows[0]) {
            const updated = await transaction<
                { version: number }[]
            >`UPDATE update_policies SET enabled=${input.enabled}, version=version+1, configuration=${updateTargetRevision(target)} WHERE target=${target.id} AND version=${input.version} RETURNING version`;
            if (!updated[0])
                throw new OperationFailure(
                    "CONFLICT",
                    "The automatic update policy changed. Refresh and try again."
                );
        }
        await auditOperation(
            transaction,
            actor,
            input.enabled ? "updates.automatic_enabled" : "updates.automatic_disabled",
            target.id
        );
    });
}
