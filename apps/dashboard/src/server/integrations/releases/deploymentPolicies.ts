import type {
    DeploymentPolicyInput,
    DeploymentPolicySummary,
} from "@homelab/contracts/deployment";
import {
    deploymentPolicySchema,
    deploymentPauseSchema,
} from "@homelab/contracts/deployment";
import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import { lockQueue } from "../../jobs/queue";
import { auditOperation } from "../../operations/audit";
import { OperationFailure } from "../../operations/errors";
import type { UpdateTarget } from "../updates/configuration";
import {
    releaseDeploymentRevision,
    type ReleaseDeploymentTarget,
} from "./deploymentConfiguration";
import { deploymentWindowEnd } from "./deploymentWindow";

type Query = SQL | TransactionSQL;
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/**
 * Read an effective per-target policy without exposing private host configuration.
 * @param client - Dashboard connection or admission transaction.
 * @param target - Current qualified host recipe.
 * @param connections - Current SSH authority.
 * @returns Manual-by-default settings, with expired timed pauses interpreted as resumed.
 */
export async function readDeploymentPolicy(
    client: Query,
    target: ReleaseDeploymentTarget,
    connections: readonly UpdateTarget[]
): Promise<DeploymentPolicySummary> {
    const [row] = await client<
        {
            version: number;
            configuration: string;
            mode: DeploymentPolicySummary["mode"];
            window: DeploymentPolicySummary["window"];
            timeZone: string;
            paused: boolean;
            reason: string | null;
            until: Date | null;
            effectivePause: boolean;
        }[]
    >`
 SELECT version,configuration,mode,"window",time_zone AS "timeZone",paused,disable_reason AS reason,disabled_until AS until,
 paused AND (disabled_until IS NULL OR disabled_until>clock_timestamp()) AS "effectivePause" FROM release_deployment_policies WHERE target=${target.id}`;
    if (!row)
        return {
            target: target.id,
            version: 0,
            mode: "manual",
            window: { start: "03:00", minutes: 60 },
            timeZone: zone(),
            paused: false,
            reason: null,
            until: null,
            configurationChanged: false,
        };
    return {
        target: target.id,
        version: row.version,
        mode: row.mode,
        window: row.window,
        timeZone: row.timeZone,
        paused: row.effectivePause,
        reason: row.effectivePause ? row.reason : null,
        until: row.effectivePause ? (row.until?.getTime() ?? null) : null,
        configurationChanged:
            row.configuration !== releaseDeploymentRevision(target, connections) ||
            row.timeZone !== zone(),
    };
}
/**
 * Save explicit human consent for a stable update scope and daily maintenance window.
 * @param client - Dashboard database.
 * @param target - Currently configured recipe whose authority is bound to this consent.
 * @param connections - Existing SSH targets.
 * @param actor - Freshly verified human identity.
 * @param input - Validated policy and optimistic version; saving preserves an existing pause.
 * @returns Completion after policy, queue fence and audit commit atomically.
 */
export async function writeDeploymentPolicy(
    client: SQL,
    target: ReleaseDeploymentTarget,
    connections: readonly UpdateTarget[],
    actor: string,
    input: DeploymentPolicyInput
): Promise<void> {
    const request = v.parse(deploymentPolicySchema, input);
    await client.begin(async (query) => {
        await lockQueue(query);
        const configuration = releaseDeploymentRevision(target, connections),
            timeZone = zone();
        const inserted = await query<
            { target: string }[]
        >`INSERT INTO release_deployment_policies(target,configuration,mode,"window",time_zone,updated_by)
  SELECT ${target.id},${configuration},${request.mode},${JSON.stringify(request.window)}::text::jsonb,${timeZone},${actor} WHERE ${request.version}=0 ON CONFLICT DO NOTHING RETURNING target`;
        if (!inserted[0]) {
            const changed = await query<
                { target: string }[]
            >`UPDATE release_deployment_policies SET version=version+1,configuration=${configuration},mode=${request.mode},"window"=${JSON.stringify(request.window)}::text::jsonb,time_zone=${timeZone},updated_by=${actor},updated_at=now() WHERE target=${target.id} AND version=${request.version} RETURNING target`;
            if (!changed[0])
                throw new OperationFailure(
                    "CONFLICT",
                    "The deployment policy changed. Refresh and try again."
                );
        }
        await auditOperation(query, actor, "releases.policy_changed", target.id);
    });
}
/**
 * Pause or resume one deployment policy with an optional explicit timed resumption.
 * @param client - Dashboard database.
 * @param actor - Fresh human with deployment-policy authority.
 * @param input - Versioned target, pause reason and optional future deadline.
 * @returns Completion after policy and audit persistence; submitted deployments continue to completion.
 */
export async function pauseDeploymentPolicy(
    client: SQL,
    actor: string,
    input: v.InferOutput<typeof deploymentPauseSchema>
): Promise<void> {
    const request = v.parse(deploymentPauseSchema, input);
    if (request.until !== null && request.until <= Date.now())
        throw new OperationFailure(
            "BAD_REQUEST",
            "Choose a future time to resume deployment."
        );
    await client.begin(async (query) => {
        await lockQueue(query);
        const changed = await query<
            { target: string }[]
        >`UPDATE release_deployment_policies SET version=version+1,paused=${request.paused},disable_reason=${request.reason},disabled_until=${request.until === null ? null : new Date(request.until)},updated_by=${actor},updated_at=now() WHERE target=${request.target} AND version=${request.version} RETURNING target`;
        if (!changed[0])
            throw new OperationFailure(
                "CONFLICT",
                "The deployment policy changed. Refresh and try again."
            );
        await auditOperation(
            query,
            actor,
            request.paused ? "releases.policy_paused" : "releases.policy_resumed",
            request.target
        );
    });
}
/**
 * Recheck automatic consent at the last queue-serialized boundary before host submission.
 * @param query - Transaction holding the queue lock.
 * @param target - Current deployment recipe.
 * @param connections - Current SSH authority.
 * @param version - Policy version captured when the operation was admitted.
 * @param windowEndsAt - Original maintenance-window deadline; waiting never carries into another day.
 * @returns Whether the exact policy still permits replacement now.
 */
export async function automaticDeploymentAllowed(
    query: Query,
    target: ReleaseDeploymentTarget,
    connections: readonly UpdateTarget[],
    version: number,
    windowEndsAt: Date
): Promise<boolean> {
    const policy = await readDeploymentPolicy(query, target, connections);
    const [clock] = await query<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const now = clock!.now.getTime();
    return (
        policy.version === version &&
        policy.mode !== "manual" &&
        !policy.paused &&
        !policy.configurationChanged &&
        windowEndsAt.getTime() > now &&
        deploymentWindowEnd(policy, now) === windowEndsAt.getTime()
    );
}
