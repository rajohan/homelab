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
import { maximumIntegrationTimeoutMs } from "../../jobs/registry";
import type { JobHandler } from "../../jobs/types";
import { OperationFailure } from "../../operations/errors";
import type { ApplicationTarget } from "../applications/configuration";
import { applyUpdate, updateTimeoutMs } from "./apply";
import type { UpdateTarget } from "./configuration";
import type { UpdateExecutor } from "./execution";
import { readUpdateReport } from "./inventory";
import { updateReceiptScope, updateReceiptResourceKeys } from "./receipts";
import { matchesUpdateTarget, updateControl } from "./selection";

const entryBudgetMs = updateTimeoutMs + 30_000;
const batchOverheadMs = 60_000;
const maximumBatchItems = Math.floor(
    (maximumIntegrationTimeoutMs - batchOverheadMs) / entryBudgetMs
);

const payloadSchema = v.strictObject({
    source: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    scope: v.nullable(v.string()),
    revision: updateBatchRequestSchema.entries.revision,
    requestId: updateBatchRequestSchema.entries.requestId,
    items: v.pipe(
        v.array(v.omit(updateRequestSchema, ["requestId"])),
        v.minLength(1),
        v.maxLength(maximumBatchItems)
    ),
});
const digest = (value: unknown) =>
    new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");

async function checkBatchAdmission(client: SQL, runId: string): Promise<void> {
    // Only successful execution on an overlapping host in this exact confirmation
    // suspends the queue-wait clock. Idle gaps and unrelated work do not renew consent.
    const [run] = await client<{ fresh: boolean; blocked: boolean | null }[]>`
        WITH admission AS (SELECT * FROM job_runs WHERE id=${runId}), related AS (
        SELECT peer.*, greatest(peer.started_at, own.created_at) AS credit_start,
            least(peer.finished_at, peer.started_at + peer.timeout_ms * interval '1 millisecond', now()) AS credit_end
        FROM admission own JOIN job_runs peer ON peer.id <> own.id
            AND peer.action LIKE 'updates.batch.%'
            AND peer.requested_by = own.requested_by
            AND peer.payload->>'requestId' = own.payload->>'requestId'
            AND peer.payload->>'revision' = own.payload->>'revision'
            AND (peer.payload->>'scope') IS NOT DISTINCT FROM (own.payload->>'scope')
            AND peer.resource_keys && ARRAY(SELECT key FROM unnest(own.resource_keys) AS resource(key) WHERE key LIKE 'host:%')
        ), credited AS (
            SELECT range_agg(tstzrange(credit_start, credit_end, '[)')) AS periods FROM related
            WHERE state='succeeded' AND started_at IS NOT NULL AND finished_at <= now() AND credit_end > credit_start
        ) SELECT own.created_at >= now() - interval '1 hour' - coalesce(
            (SELECT sum(upper(period)-lower(period)) FROM credited, unnest(periods) AS credit(period)), interval '0 seconds') AS fresh,
            (SELECT bool_or(state IN ('failed','timed_out','cancelled')) FROM related) AS blocked
        FROM admission own`;
    if (run?.blocked)
        throw new Error(
            "Another batch in this confirmation failed or was cancelled on this host; remaining updates were not started"
        );
    if (!run?.fresh) throw new Error("Batch update authorization expired");
}

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
            else if (item.kind === "runtime")
                reason = "Use the separate toolchain update controls.";
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
    for (const source of sources) {
        if (
            eligible.filter((entry) => entry.source === source.id).length >
            maximumBatchItems
        )
            throw new OperationFailure(
                "TOO_MANY_REQUESTS",
                `A host can include at most ${maximumBatchItems} updates in one batch. Install some updates individually before confirming this host.`
            );
    }
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
 * @param applications - Explicit source bindings for verified namespace recreation receipts.
 * @returns Non-retryable host jobs sharing resource leases with individual installations.
 */
export function updateBatchJobs(
    targets: readonly UpdateTarget[],
    client: SQL,
    execute: UpdateExecutor,
    applications: readonly ApplicationTarget[] = []
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
                    ...new Set(
                        owned.flatMap((target) =>
                            updateReceiptResourceKeys(
                                updateReceiptScope(target, targets, applications)
                            )
                        )
                    ),
                ],
                timeoutMs: maximumBatchItems * entryBudgetMs + batchOverheadMs,
                attemptLimit: 1,
                retrySafe: false,
                intervalSeconds: null,
                admission: "integration",
                validate: (input) => v.parse(payloadSchema, input),
            },
            execute: async (value, context) => {
                const input = v.parse(payloadSchema, value);
                if (input.source !== source)
                    throw new Error("Batch update authorization expired");
                await checkBatchAdmission(client, context.runId);
                // Update consumers before their provider. Provider recreation then
                // keeps their newly approved images; it cannot stale a later item ID.
                const ordered: typeof input.items = [];
                const visiting = new Set<string>();
                const visit = (entry: (typeof input.items)[number]) => {
                    if (ordered.includes(entry)) return;
                    if (visiting.has(entry.target))
                        throw new Error("Update namespace dependency cycle");
                    visiting.add(entry.target);
                    const target = owned.find(
                        (candidate) => candidate.id === entry.target
                    );
                    if (target?.driver.kind === "docker") {
                        const driver = target.driver;
                        for (const dependent of owned.filter(
                            (candidate) =>
                                candidate.driver.kind === "docker" &&
                                candidate.host === target.host &&
                                candidate.driver.project === driver.project &&
                                driver.namespaceDependents?.includes(
                                    candidate.driver.service
                                )
                        )) {
                            const item = input.items.find(
                                (candidate) => candidate.target === dependent.id
                            );
                            if (item) visit(item);
                        }
                    }
                    visiting.delete(entry.target);
                    ordered.push(entry);
                };
                for (const entry of input.items) visit(entry);
                for (const [index, entry] of ordered.entries()) {
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
                            execute,
                            updateReceiptScope(target, targets, applications)
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
                    {
                        ...handler.definition,
                        timeoutMs: items.length * entryBudgetMs + batchOverheadMs,
                    },
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
