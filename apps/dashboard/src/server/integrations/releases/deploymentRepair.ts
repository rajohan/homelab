import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";
import { updateResourceKeys, type UpdateTarget } from "../updates/configuration";
import {
    deploymentMiraService,
    type ReleaseDeploymentTarget,
} from "./deploymentConfiguration";
import { preparedDeployment } from "./deploymentPlans";
import {
    type DeploymentHost,
    deploymentHost,
    type DeploymentObservation,
} from "./deploymentProtocol";

const repairSchema = v.strictObject({
    revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});

/** Describe a narrowly scoped recovery stop for the configured Mira executor.
 * @param query - Dashboard database or the fenced recovery transaction.
 * @param target - Current reviewed deployment recipe.
 * @param observed - Operator-reviewed identities from the fresh release preparation.
 * @returns Null unless the exact executor is running without a fresh heartbeat. A blocked stop always explains why.
 */
export async function miraRepairState(
    query: SQL | TransactionSQL,
    target: ReleaseDeploymentTarget,
    observed?: DeploymentObservation
) {
    const executor = deploymentMiraService(target);
    if (!executor || !observed?.containers[executor]?.running) return null;
    const [row] = await query<{ fresh: boolean; busy: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM mira_runtime_status WHERE heartbeat_at > clock_timestamp()-interval '45 seconds') AS fresh,
            EXISTS(SELECT 1 FROM release_deployments WHERE finished_at IS NULL)
            OR EXISTS(SELECT 1 FROM mira_runs WHERE state='running' AND lease_expires_at>clock_timestamp())
            OR EXISTS(SELECT 1 FROM mira_chat_inputs WHERE state='sending')
            OR EXISTS(SELECT 1 FROM mira_daytona_jobs WHERE cleanup='pending' OR state='running' OR lease_expires_at>clock_timestamp())
            OR EXISTS(SELECT 1 FROM mira_integration_state WHERE lease_expires_at>clock_timestamp())
            OR EXISTS(SELECT 1 FROM mira_mail_drafts WHERE state='sending')
            OR EXISTS(SELECT 1 FROM mira_publications WHERE state='publishing')
            OR EXISTS(SELECT 1 FROM mira_social_drafts WHERE state IN ('publishing','verifying'))
            OR EXISTS(SELECT 1 FROM mira_code_publications WHERE state='publishing')
            OR EXISTS(SELECT 1 FROM mira_improvements WHERE lease_expires_at>clock_timestamp())
            OR EXISTS(SELECT 1 FROM mira_computer_commands WHERE state='claimed')
            OR EXISTS(SELECT 1 FROM mira_browser_processes WHERE state<>'removed') AS busy`;
    if (!row || row.fresh) return null;
    return { canStop: !row.busy };
}

/** Register an operator-confirmed, single-attempt stop against a frozen release observation.
 * @param targets - Configured release recipes with an exact Mira executor.
 * @param connections - Approved, pinned SSH authorities for those recipes.
 * @param host - Ordinary bounded release protocol transport.
 * @returns Integration-only workers for the configured Mira executors.
 */
export function deploymentRepairJobs(
    targets: readonly ReleaseDeploymentTarget[],
    connections: readonly UpdateTarget[],
    host: DeploymentHost = deploymentHost
): JobHandler[] {
    return targets
        .flatMap((target) => {
            const executor = deploymentMiraService(target);
            return executor ? [{ target, executor }] : [];
        })
        .map(({ target, executor }) => {
            const connection = connections.find((c) => c.id === target.connection)!;
            return {
                definition: {
                    key: `homelab.repair.${target.id}`,
                    label: "Stop unresponsive Mira",
                    description:
                        "Stop the exact unresponsive executor identified in a reviewed release preparation.",
                    admission: "integration",
                    capability: "updates:apply",
                    resourceClass: "interactive",
                    resourceKeys: updateResourceKeys(connection),
                    attemptLimit: 1,
                    retrySafe: false,
                    timeoutMs: 60_000,
                    intervalSeconds: null,
                    validate: (input) => v.parse(repairSchema, input),
                },
                execute: async (payload, context) => {
                    const { revision } = v.parse(repairSchema, payload);
                    await context.reportProgress(
                        "Checking the reviewed executor and in-flight work."
                    );
                    const owned = await context.commit(async (t) => {
                        const prepared = await preparedDeployment(t, target, connections);
                        if (!prepared.plan || prepared.revision !== revision)
                            throw new Error("Prepare the release again.");
                        // Serialize all claims that could dispatch an external effect, including claims
                        // from an executor whose heartbeat failed. Release these locks as soon as the
                        // original process is confirmed stopped. NOWAIT leaves a busy service alone.
                        await t`LOCK TABLE mira_runtime_status, mira_runs, mira_chat_inputs, mira_daytona_jobs, mira_integration_state,
                        mira_mail_drafts, mira_publications, mira_social_drafts, mira_code_publications, mira_improvements,
                        mira_computer_commands, mira_browser_processes IN SHARE MODE NOWAIT`;
                        const repair = await miraRepairState(
                            t,
                            target,
                            prepared.plan.expected
                        );
                        if (!repair?.canStop)
                            throw new Error("Mira recovered or work is still active.");
                        const receipt = await host(
                            connection,
                            {
                                mode: "stop-mira",
                                target,
                                expected: prepared.plan.expected,
                                deadline: Date.now() / 1000 + 30,
                            },
                            context.signal
                        );
                        v.parse(
                            v.object({
                                id: v.literal(
                                    prepared.plan.expected.containers[executor]!.id
                                ),
                                stopped: v.literal(true),
                            }),
                            receipt
                        );
                        await t`DELETE FROM operation_snapshots WHERE key=${`homelab.prepare.${target.id}`}`;
                    }, true);
                    if (!owned) throw new Error("The recovery job lost its claim.");
                    await context.reportProgress(
                        "Mira stopped. Prepare the release again to verify the new host state."
                    );
                },
            };
        });
}
