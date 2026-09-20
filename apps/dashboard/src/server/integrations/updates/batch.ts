import {
    updateBatchRequestSchema,
    updateRequestSchema,
    type UpdateBatchEntry,
    type UpdateBatchPlan,
    type UpdateSource,
} from "@homelab/contracts/updates";
import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import { enqueueJob, lockQueue } from "../../jobs/queue";
import type { JobHandler } from "../../jobs/types";
import { OperationFailure } from "../../operations/errors";
import { applyUpdate } from "./apply";
import { updateResourceKeys, type UpdateTarget } from "./configuration";
import type { UpdateExecutor } from "./execution";
import { readUpdateReport } from "./inventory";
import { matchesUpdateTarget, updateControl } from "./selection";

const payloadSchema = v.strictObject({
    source: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    scope: v.nullable(v.string()),
    revision: updateBatchRequestSchema.entries.revision,
    requestId: updateBatchRequestSchema.entries.requestId,
    items: v.pipe(
        v.array(v.omit(updateRequestSchema, ["requestId"])),
        v.minLength(1),
        v.maxLength(5000)
    ),
});
const digest = (value: unknown) =>
    new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Derive a bounded job key for a configured reporting source.
 * @param source - Exact source identity, never a browser-supplied action name.
 * @returns A stable registered action key even for long source IDs.
 */
export function updateBatchKey(source: string): string {
    return `updates.batch.${digest(source).slice(0, 32)}`;
}

/**
 * Build a complete confirmation plan independently of table filters and pagination.
 * @param client - Operational database or its admission transaction.
 * @param sources - Explicitly registered reporting hosts.
 * @param targets - Deployment-owned installation recipes.
 * @param registry - Installers actually registered in this runtime.
 * @param scope - One source, or undefined for all configured sources.
 * @returns Exact candidate revisions and an explanation for every excluded update.
 */
export async function readUpdateBatchPlan(
    client: SQL | TransactionSQL,
    sources: readonly UpdateSource[],
    targets: readonly UpdateTarget[],
    registry: ReadonlyMap<string, JobHandler>,
    scope?: string
): Promise<UpdateBatchPlan> {
    if (scope && !sources.some((source) => source.id === scope))
        throw new OperationFailure("NOT_FOUND", "This update source is not configured.");
    const entries: UpdateBatchEntry[] = [];
    for (const source of sources.filter(
        (candidate) => !scope || candidate.id === scope
    )) {
        const report = await readUpdateReport(client, source.id);
        if (!report) continue;
        for (const item of report.items.filter(
            (candidate) => candidate.status === "available"
        )) {
            const matches = targets.filter(
                (target) =>
                    target.source === source.id && matchesUpdateTarget(target, item)
            );
            const target = matches.length === 1 ? matches[0] : undefined;
            const control = target ? updateControl(target, report, item) : null;
            let reason = control?.reason ?? null;
            if (
                !target ||
                !registry.has(`updates.install.${target.id}`) ||
                !registry.has(updateBatchKey(source.id))
            )
                reason =
                    "Update installation is not configured unambiguously for this software.";
            else if (control?.change === "major")
                reason = "Major upgrades require separate confirmation.";
            entries.push({
                source: source.id,
                sourceLabel: source.label,
                item,
                control,
                reason,
            });
        }
    }
    entries.sort((left, right) => {
        const a = JSON.stringify([left.source, left.item.id]);
        const b = JSON.stringify([right.source, right.item.id]);
        return a < b ? -1 : Number(a > b);
    });
    if (entries.length > 5000)
        throw new OperationFailure(
            "TOO_MANY_REQUESTS",
            "There are too many updates for one confirmation. Select an individual host."
        );
    const eligible = entries.filter((entry) => entry.reason === null);
    return {
        revision: digest([scope ?? null, entries]),
        entries,
        eligible: eligible.length,
        excluded: entries.length - eligible.length,
        hosts: new Set(eligible.map((entry) => entry.source)).size,
    };
}

/**
 * Execute confirmed updates sequentially per source using the ordinary installer boundary.
 * @param targets - Explicit installation recipes; no access is inferred from inventory.
 * @param client - Operational state used to revalidate each candidate immediately before execution.
 * @param execute - Worker-only installer, replaced by the isolated preview in development.
 * @returns Non-retryable host jobs sharing resource leases with individual installations.
 */
export function updateBatchJobs(
    targets: readonly UpdateTarget[],
    client: SQL,
    execute: UpdateExecutor
): JobHandler[] {
    return [...new Set(targets.map((target) => target.source))].map((source) => {
        const owned = targets.filter((target) => target.source === source);
        return {
            definition: {
                key: updateBatchKey(source),
                label: "Update host software",
                description:
                    "Install confirmed updates in order; stop this host on failure without rebooting or rolling back application data.",
                resourceClass: "interactive",
                capability: "updates:apply",
                resourceKeys: [
                    ...new Set(owned.flatMap((target) => updateResourceKeys(target))),
                ],
                timeoutMs: 3_600_000,
                attemptLimit: 1,
                retrySafe: false,
                intervalSeconds: null,
                admission: "integration",
                validate: (input) => v.parse(payloadSchema, input),
            },
            execute: async (value, context) => {
                const input = v.parse(payloadSchema, value);
                const [run] = await client<
                    { fresh: boolean }[]
                >`SELECT created_at >= now() - interval '1 hour' AS fresh FROM job_runs WHERE id=${context.runId}`;
                if (!run?.fresh || input.source !== source)
                    throw new Error("Batch update authorization expired");
                for (const [index, entry] of input.items.entries()) {
                    context.signal.throwIfAborted();
                    const target = owned.find(
                        (candidate) => candidate.id === entry.target
                    );
                    const report = await readUpdateReport(client, source);
                    const item = report?.items.find(
                        (candidate) => candidate.id === entry.item
                    );
                    if (!target || !report || !item)
                        throw new Error(
                            "An approved update is no longer available; remaining updates were not started"
                        );
                    const control = updateControl(target, report, item);
                    if (
                        !control.allowed ||
                        control.revision !== entry.revision ||
                        control.change === "major"
                    )
                        throw new Error(
                            "An approved update changed; remaining updates were not started"
                        );
                    const label = item.name.replaceAll(/[\p{Cc}]/gu, " ");
                    const prefix = `${index + 1}/${input.items.length} · ${label}`;
                    await context.reportProgress(
                        `${prefix}: preparing the approved update.`
                    );
                    try {
                        await applyUpdate(
                            target,
                            item,
                            false,
                            {
                                ...context,
                                reportProgress: (message) =>
                                    context.reportProgress(`${prefix}: ${message}`),
                            },
                            execute
                        );
                    } catch (error) {
                        if (!context.signal.aborted)
                            await context.reportProgress(
                                `${prefix}: failed. ${input.items.length - index - 1} remaining updates were not started.`
                            );
                        throw error;
                    }
                }
                await context.reportProgress(
                    `Completed and verified ${input.items.length} updates.`
                );
            },
        } satisfies JobHandler;
    });
}

/**
 * Atomically admit one job per selected host after rechecking the entire confirmation plan.
 * @param client - Operational state, never application or identity databases.
 * @param sources - Configured reporting sources.
 * @param targets - Configured update recipes.
 * @param registry - The current worker registry.
 * @param actor - Authorized caller, used for isolated replay protection and audit.
 * @param input - Plan digest, optional source and a caller-generated request ID.
 * @returns Accepted run IDs; no installer runs in the HTTP request.
 */
export async function requestUpdateBatch(
    client: SQL,
    sources: readonly UpdateSource[],
    targets: readonly UpdateTarget[],
    registry: ReadonlyMap<string, JobHandler>,
    actor: string,
    input: v.InferOutput<typeof updateBatchRequestSchema>
): Promise<{ id: string; ids: string[] }> {
    return client.begin(async (transaction) => {
        await lockQueue(transaction);
        const prefix = `${actor}:update-batch:${input.requestId}:`;
        const existing = await transaction<
            { id: string; payload: v.InferOutput<typeof payloadSchema> }[]
        >`SELECT id, payload FROM job_runs WHERE left(idempotency_key, length(${prefix}))=${prefix} ORDER BY id`;
        if (existing.length > 0) {
            if (
                existing.some(
                    (row) =>
                        row.payload.revision !== input.revision ||
                        row.payload.scope !== (input.source ?? null)
                )
            )
                throw new OperationFailure(
                    "CONFLICT",
                    "This request ID was already used for another update plan."
                );
            return { id: existing[0]!.id, ids: existing.map((row) => row.id) };
        }
        const plan = await readUpdateBatchPlan(
            transaction,
            sources,
            targets,
            registry,
            input.source
        );
        if (plan.revision !== input.revision)
            throw new OperationFailure(
                "CONFLICT",
                "The update plan changed. Close this dialog and review the current updates."
            );
        if (plan.eligible === 0)
            throw new OperationFailure(
                "PRECONDITION_FAILED",
                "No updates in this plan can be installed."
            );
        const ids: string[] = [];
        for (const source of sources) {
            const entries = plan.entries.filter(
                (entry) => entry.source === source.id && entry.reason === null
            );
            if (entries.length === 0) continue;
            const handler = registry.get(updateBatchKey(source.id));
            if (!handler) throw new Error("Missing registered batch installer");
            const items = entries.map((entry) => ({
                target: entry.control!.target,
                item: entry.item.id,
                revision: entry.control!.revision,
            }));
            ids.push(
                await enqueueJob(
                    transaction,
                    handler.definition,
                    actor,
                    prefix + source.id,
                    {
                        source: source.id,
                        scope: input.source ?? null,
                        revision: input.revision,
                        requestId: input.requestId,
                        items,
                    },
                    `Update ${source.label} · ${items.length} updates`
                )
            );
        }
        return { id: ids[0]!, ids };
    });
}
