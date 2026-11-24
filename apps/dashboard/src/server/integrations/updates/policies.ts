import {
    type UpdatePolicy,
    type UpdatePolicyGroupInput,
    updatePolicyNeedsChange,
} from "@homelab/contracts/updates";
import type { SQL, TransactionSQL } from "bun";

import { hostResourceKey } from "../../jobs/resources";
import { auditOperation } from "../../operations/audit";
import { OperationFailure } from "../../operations/errors";
import { type UpdateTarget, updateTargetRevision } from "./configuration";

/**
 * Read policy only for currently configured update targets; new or changed recipes stay off.
 * @param client - Dashboard-only database.
 * @param targets - Current deployment registry.
 * @returns Safe policy summaries without paths, recipes or SSH identities.
 */
export async function readUpdatePolicies(
    client: SQL | TransactionSQL,
    targets: readonly UpdateTarget[]
): Promise<UpdatePolicy[]> {
    const rows = await client<
        {
            target: string;
            enabled: boolean;
            version: number;
            configuration: string;
            allowDigest: boolean;
        }[]
    >`SELECT target, enabled, version, configuration, allow_digest AS "allowDigest" FROM update_policies`;
    return targets.map((target) => {
        const row = rows.find((policy) => policy.target === target.id);
        const changed = Boolean(
            row && row.configuration !== updateTargetRevision(target)
        );
        return {
            target: target.id,
            host: hostResourceKey(target.host),
            revision: updateTargetRevision(target),
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
            ...(target.driver.kind === "docker" &&
            (target.driver.trackingTag ?? "latest") === "latest"
                ? { allowDigest: Boolean(row?.enabled && !changed && row.allowDigest) }
                : {}),
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
    input: { enabled: boolean; version: number; allowDigest?: boolean | undefined }
): Promise<void> {
    await client.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock(hashtext('dashboard-update-policies'))`;
        await savePolicy(transaction, target, actor, input);
    });
}

async function savePolicy(
    transaction: TransactionSQL,
    target: UpdateTarget,
    actor: string,
    input: { enabled: boolean; version: number; allowDigest?: boolean | undefined }
) {
    if (
        input.allowDigest &&
        (!input.enabled ||
            target.driver.kind !== "docker" ||
            (target.driver.trackingTag ?? "latest") !== "latest")
    )
        throw new OperationFailure(
            "BAD_REQUEST",
            "Digest-only updates require an enabled Docker service tracking latest."
        );
    const revision = updateTargetRevision(target);
    const rows = await transaction<
        { version: number }[]
    >`INSERT INTO update_policies (target, enabled, version, configuration, allow_digest) SELECT ${target.id}, ${input.enabled}, 1, ${revision}, ${input.allowDigest ?? false} WHERE ${input.version} = 0 ON CONFLICT (target) DO NOTHING RETURNING version`;
    if (!rows[0]) {
        const updated = await transaction<
            { version: number }[]
        >`UPDATE update_policies SET enabled=${input.enabled}, version=version+1, configuration=${revision},
            allow_digest=${input.enabled} AND COALESCE(${input.allowDigest ?? null}::boolean, enabled AND configuration=${revision} AND allow_digest)
            WHERE target=${target.id} AND version=${input.version} RETURNING version`;
        if (!updated[0])
            throw new OperationFailure(
                "CONFLICT",
                "The automatic update policy changed. Refresh and try again."
            );
    }
    let action = input.enabled
        ? "updates.automatic_enabled"
        : "updates.automatic_disabled";
    if (input.allowDigest !== undefined)
        action = input.allowDigest ? "updates.digest_enabled" : "updates.digest_disabled";
    await auditOperation(transaction, actor, action, target.id);
}

/** Apply one confirmed host or fleet change atomically against the reviewed recipes and policy versions.
 * @param client - Dashboard database owning policies and their audit trail.
 * @param targets - Complete configured registry.
 * @param actor - Verified human operator.
 * @param input - Scope, desired state and snapshots shown at confirmation.
 * @returns The number of policies updated together.
 */
export async function writeUpdatePolicyGroup(
    client: SQL,
    targets: readonly UpdateTarget[],
    actor: string,
    input: UpdatePolicyGroupInput
) {
    const scope = targets.filter(
        (target) => input.host === null || hostResourceKey(target.host) === input.host
    );
    return client.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock(hashtext('dashboard-update-policies'))`;
        const policies = await readUpdatePolicies(transaction, scope);
        const expected = new Map(input.expected.map((item) => [item.target, item]));
        if (
            scope.length === 0 ||
            expected.size !== input.expected.length ||
            policies.length !== expected.size ||
            policies.some(
                (policy) =>
                    expected.get(policy.target)?.revision !== policy.revision ||
                    expected.get(policy.target)?.version !== policy.version
            )
        ) {
            throw new OperationFailure(
                "CONFLICT",
                "The update targets or policies changed. Refresh and review them again."
            );
        }
        const changes = policies.filter((policy) =>
            updatePolicyNeedsChange(policy, input.enabled)
        );
        for (const policy of changes) {
            const target = scope.find((entry) => entry.id === policy.target)!;
            await savePolicy(transaction, target, actor, {
                enabled: input.enabled,
                version: policy.version,
            });
        }
        return { updated: changes.length };
    });
}
