import type { MiraDaytonaContent } from "@homelab/contracts/miraDaytona";
import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import { miraActionApproval } from "../data/approvalPolicy";
import { requireConversation, requireTask } from "../data/context";
import { miraDaytonaHash, validateDaytonaInputs } from "../data/daytona";
import { readMiraFile, saveMiraFile } from "../data/files";
import { improvementJobAllowed } from "../improvement/policy";
import {
    localCodeBindingHash,
    localCodeBindingSchema,
    localCodePermission,
    type LocalCodeBinding,
} from "./localBinding";
import {
    cleanupLocalCodeContainer,
    executeLocalCodeCheck,
    type LocalCodeJournal,
} from "./localContainer";
import {
    localCodeRequest,
    parseLocalCheckInput,
    parseLocalCheckResult,
} from "./localProtocol";

interface Job {
    id: string;
    owner: string;
    binding: LocalCodeBinding;
    bindingHash: string;
    content: MiraDaytonaContent;
    contentHash: string;
    conversationId: string | null;
    taskId: string | null;
    controlVersion: number;
    state: string;
    phase: string;
    containerId: string | null;
    settled: boolean;
    cleanup: string;
    token: string;
}

async function transaction<T>(
    client: SQL,
    signal: AbortSignal,
    operation: (query: TransactionSQL) => Promise<T>
): Promise<T> {
    signal.throwIfAborted();
    return client.begin(async (query) => {
        await query`SET LOCAL statement_timeout='4s'`;
        await query`SET LOCAL lock_timeout='4s'`;
        signal.throwIfAborted();
        const result = await operation(query);
        signal.throwIfAborted();
        return result;
    });
}

async function ownerLock(query: TransactionSQL, owner: string): Promise<void> {
    await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${owner}`},0))`;
}

async function authority(query: TransactionSQL, job: Job): Promise<void> {
    if ((await localCodePermission(query, job.binding)) !== job.controlVersion)
        throw new Error("Local code permission changed.");
    if (
        !(await miraActionApproval(query, job.owner, "job", job.id)) ||
        !(await improvementJobAllowed(query, job.id, "cloud"))
    )
        throw new Error("Automatic code authority changed.");
    await requireConversation(query, job.owner, job.conversationId);
    await requireTask(query, job.owner, job.taskId);
    const [row] = await query<
        { id: string }[]
    >`SELECT id FROM mira_daytona_jobs WHERE id=${job.id} AND execution_target='main' AND owner=${job.owner} AND content_hash=${job.contentHash} AND binding_hash=${job.bindingHash} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND deadline>clock_timestamp() AND state='running' AND NOT cancel_requested FOR UPDATE`;
    if (!row) throw new Error("Local code lease or authority expired.");
}

async function claim(
    client: SQL,
    binding: LocalCodeBinding,
    signal: AbortSignal
): Promise<Job | null> {
    const [candidate] = await client<
        { id: string; owner: string }[]
    >`SELECT id,owner FROM mira_daytona_jobs WHERE execution_target='main' AND binding->>'hostId'=${binding.hostId} AND ((state='queued' AND owner=${binding.owner}) OR cleanup='pending' OR (state='running' AND phase='collecting')) AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) AND (retry_at IS NULL OR retry_at<=clock_timestamp()) ORDER BY CASE WHEN state='queued' THEN 1 ELSE 0 END,approved_at,id LIMIT 1`;
    if (!candidate) return null;
    return transaction(client, signal, async (query) => {
        await ownerLock(query, candidate.owner);
        await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:daytona:admission',0))`;
        const [row] = await query<
            Omit<Job, "token">[]
        >`SELECT id,owner,binding,binding_hash AS "bindingHash",content,content_hash AS "contentHash",conversation_id AS "conversationId",task_id AS "taskId",control_version AS "controlVersion",state,phase,local_container_id AS "containerId",local_creation_settled AS settled,cleanup FROM mira_daytona_jobs WHERE id=${candidate.id} AND execution_target='main' AND (state='queued' OR cleanup='pending' OR (state='running' AND phase='collecting')) AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) FOR UPDATE`;
        if (!row) return null;
        const original = v.parse(localCodeBindingSchema, row.binding);
        if (original.hostId !== binding.hostId || original.owner !== row.owner)
            throw new Error("Local code recovery belongs to a different host or owner.");
        if (row.state === "queued") {
            try {
                const [fresh] = await query<
                    { allowed: boolean }[]
                >`SELECT approved_at>clock_timestamp()-interval '15 minutes' AND NOT cancel_requested AS allowed FROM mira_daytona_jobs WHERE id=${row.id}`;
                if (
                    !fresh?.allowed ||
                    !(await miraActionApproval(query, row.owner, "job", row.id)) ||
                    !(await improvementJobAllowed(query, row.id, "cloud")) ||
                    row.bindingHash !== localCodeBindingHash(binding) ||
                    row.contentHash !== miraDaytonaHash(row.content) ||
                    (await localCodePermission(query, binding)) !== row.controlVersion
                )
                    throw new Error("Local approval changed.");
                localCodeRequest(row.id, row.content);
                await requireConversation(query, row.owner, row.conversationId);
                await requireTask(query, row.owner, row.taskId);
                await validateDaytonaInputs(query, row.owner, row.content);
            } catch {
                await query`UPDATE mira_daytona_jobs SET state=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'draft' END,approval_run_id=NULL,approved_at=NULL,control_version=NULL,version=version+1,message='Local approval or input changed. Review this job again.' WHERE id=${row.id}`;
                return null;
            }
            const [busy] = await query<
                { active: boolean }[]
            >`SELECT EXISTS(SELECT 1 FROM mira_daytona_jobs WHERE cleanup='pending') AS active`;
            if (busy?.active) return null;
            await query`UPDATE mira_daytona_jobs SET state='running',phase='admitted',cleanup='pending',started_at=clock_timestamp(),deadline=clock_timestamp()+interval '15 minutes',message=NULL,version=version+1 WHERE id=${row.id}`;
        }
        const token = crypto.randomUUID();
        await query`UPDATE mira_daytona_jobs SET lease_token=${token},lease_expires_at=clock_timestamp()+interval '90 seconds',retry_at=NULL,updated_at=clock_timestamp() WHERE id=${row.id}`;
        return { ...row, binding: original, token };
    });
}

function journal(client: SQL, job: Job): LocalCodeJournal {
    const write = (
        signal: AbortSignal,
        action: (query: TransactionSQL) => Promise<{ id: string }[]>,
        authorized = false
    ) =>
        transaction(client, signal, async (query) => {
            if (authorized) {
                await ownerLock(query, job.owner);
                await authority(query, job);
            }
            const rows = await action(query);
            if (!rows[0]) throw new Error("Local code lifecycle changed.");
        });
    return {
        creating: (signal) =>
            write(
                signal,
                (query) =>
                    query`UPDATE mira_daytona_jobs SET phase='creating',updated_at=clock_timestamp() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND phase='admitted' AND cleanup='pending' RETURNING id`,
                true
            ),
        created: (id, signal) =>
            write(
                signal,
                (query) =>
                    query`UPDATE mira_daytona_jobs SET local_container_id=${id},local_creation_settled=true,phase='created',updated_at=clock_timestamp() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND phase='creating' AND cleanup='pending' AND local_container_id IS NULL RETURNING id`
            ),
        rejected: (signal) =>
            write(
                signal,
                (query) =>
                    query`UPDATE mira_daytona_jobs SET local_creation_settled=true WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND phase='creating' AND cleanup='pending' RETURNING id`
            ),
        starting: (signal) =>
            write(
                signal,
                (query) =>
                    query`UPDATE mira_daytona_jobs SET phase='executing',updated_at=clock_timestamp() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND phase='created' AND cleanup='pending' RETURNING id`,
                true
            ),
        cleaning: (signal) =>
            write(
                signal,
                (query) =>
                    query`UPDATE mira_daytona_jobs SET phase='cleaning',updated_at=clock_timestamp() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND cleanup='pending' RETURNING id`
            ),
        discovered: (id, signal) =>
            write(
                signal,
                (query) =>
                    query`UPDATE mira_daytona_jobs SET local_container_id=${id},local_creation_settled=true WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND phase='cleaning' AND cleanup='pending' AND (local_container_id IS NULL OR local_container_id=${id}) RETURNING id`
            ),
        cleaned: (signal) =>
            write(
                signal,
                (query) =>
                    query`UPDATE mira_daytona_jobs SET cleanup='confirmed',phase='collecting',updated_at=clock_timestamp() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND phase='cleaning' AND cleanup='pending' RETURNING id`
            ),
    };
}

/**
 * Run one reviewed fixed-profile job on its original local host, or reconcile an interrupted attempt.
 * @param options - Trusted host identity/socket, current deployment, private files and permanent shutdown signal.
 * @param dependencies - Synthetic container boundaries for qualification, never model-controlled.
 * @returns Whether a job was claimed; cleanup uncertainty remains reserved and is retried without execution replay.
 */
export async function dispatchMiraLocalCode(
    options: {
        client: SQL;
        binding: LocalCodeBinding;
        socketPath: string;
        filesDirectory?: string | undefined;
        signal: AbortSignal;
    },
    dependencies: {
        execute?: typeof executeLocalCodeCheck;
        cleanup?: typeof cleanupLocalCodeContainer;
    } = {}
): Promise<boolean> {
    const { client, signal } = options;
    const binding = v.parse(localCodeBindingSchema, options.binding);
    const job = await claim(client, binding, signal);
    if (!job) return false;
    const controller = new AbortController();
    const running = AbortSignal.any([signal, controller.signal]);
    const callbacks = journal(client, job);
    const config = {
        socketPath: options.socketPath,
        imageId: job.binding.imageId,
        egress: job.binding.egress,
    };
    const context = { client, owner: job.owner, actor: `local-code:${job.id}` };
    const cleanup = async () => {
        const [row] = await client<
            {
                containerId: string | null;
                settled: boolean;
                phase: string;
                cleanup: string;
            }[]
        >`SELECT local_container_id AS "containerId",local_creation_settled AS settled,phase,cleanup FROM mira_daytona_jobs WHERE id=${job.id} AND lease_token=${job.token}`;
        if (!row) throw new Error("Local code cleanup lease lost.");
        if (row.cleanup === "confirmed") return;
        await (dependencies.cleanup ?? cleanupLocalCodeContainer)(
            config,
            {
                id: job.id,
                containerId: row.containerId ?? undefined,
                settled: row.settled || row.phase === "admitted",
            },
            callbacks
        );
    };
    let renewing: Promise<void> | undefined;
    const timer = setInterval(() => {
        if (renewing || running.aborted) return;
        renewing = transaction(client, running, async (query) => {
            await ownerLock(query, job.owner);
            await authority(query, job);
            await query`UPDATE mira_daytona_jobs SET lease_expires_at=clock_timestamp()+interval '90 seconds' WHERE id=${job.id} AND lease_token=${job.token}`;
        })
            .catch(() => controller.abort())
            .finally(() => {
                renewing = undefined;
            });
    }, 2000);
    timer.unref();
    try {
        if (job.state !== "queued") {
            await cleanup();
            await transaction(
                client,
                AbortSignal.timeout(10_000),
                (query) =>
                    query`UPDATE mira_daytona_jobs SET state=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'needs_attention' END,outcome=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'needs_attention' END,phase='closed',message='Interrupted local execution was cleaned up. It was not replayed.',version=version+1 WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND cleanup='confirmed'`
            );
            return true;
        }
        const request = localCodeRequest(job.id, job.content);
        const selected = job.content.inputs[0];
        const file = selected
            ? await readMiraFile(context, options.filesDirectory, selected.id)
            : null;
        const input = parseLocalCheckInput({
            request,
            input: file
                ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                      file.bytes
                  )
                : null,
        });
        const result = parseLocalCheckResult(
            await (dependencies.execute ?? executeLocalCodeCheck)(
                config,
                input,
                callbacks,
                running
            ),
            request
        );
        running.throwIfAborted();
        for (const output of result.files) {
            const id = Bun.randomUUIDv7();
            await saveMiraFile(
                context,
                options.filesDirectory,
                { id, name: output.name, bytes: Buffer.from(output.text) },
                async (query) => {
                    running.throwIfAborted();
                    await authority(query, job);
                    const [stored] = await query<
                        { id: string }[]
                    >`UPDATE mira_daytona_jobs SET files=files || ${JSON.stringify([{ name: output.name, id }])}::text::jsonb WHERE id=${job.id} AND lease_token=${job.token} AND phase='collecting' AND cleanup='confirmed' RETURNING id`;
                    if (!stored) throw new Error("Local result collection changed.");
                }
            );
        }
        await transaction(client, running, async (query) => {
            await ownerLock(query, job.owner);
            await authority(query, job);
            const outcome = result.exitCode === 0 ? "completed" : "failed";
            const [done] = await query<
                { id: string }[]
            >`UPDATE mira_daytona_jobs SET state=${outcome},outcome=${outcome},exit_code=${result.exitCode},phase='closed',message=NULL,version=version+1,updated_at=clock_timestamp() WHERE id=${job.id} AND lease_token=${job.token} AND phase='collecting' AND cleanup='confirmed' RETURNING id`;
            if (!done) throw new Error("Local code finalization changed.");
        });
    } catch {
        controller.abort();
        // An admitted attempt has never passed the durable pre-create boundary.
        const reset = await transaction(
            client,
            AbortSignal.timeout(10_000),
            (query) =>
                query<
                    { id: string }[]
                >`UPDATE mira_daytona_jobs SET state=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'draft' END,outcome=CASE WHEN cancel_requested THEN 'cancelled' ELSE NULL END,phase=CASE WHEN cancel_requested THEN 'closed' ELSE 'idle' END,cleanup='not_needed',approval_run_id=NULL,approved_at=NULL,control_version=NULL,started_at=NULL,deadline=NULL,retry_at=NULL,message='Local execution did not start. Review this job again.',version=version+1,updated_at=clock_timestamp() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND state='running' AND phase='admitted' AND local_container_id IS NULL AND NOT local_creation_settled RETURNING id`
        ).catch(() => []); // A database failure must not prevent independent container cleanup.
        if (reset[0]) return true;
        try {
            await cleanup();
        } catch {
            // Never release capacity without confirmed absence, even after a pause or shutdown.
        }
        await transaction(
            client,
            AbortSignal.timeout(10_000),
            (query) =>
                query`UPDATE mira_daytona_jobs SET state=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'needs_attention' END,outcome=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'needs_attention' END,phase=CASE WHEN cleanup='confirmed' THEN 'closed' ELSE 'cleaning' END,retry_at=CASE WHEN cleanup='pending' THEN clock_timestamp()+interval '30 seconds' ELSE NULL END,message='Local execution could not be confirmed. Cleanup is tracked separately; work was not replayed.',version=version+1,updated_at=clock_timestamp() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND phase<>'closed'`
        );
    } finally {
        clearInterval(timer);
        controller.abort();
        await renewing;
        await transaction(
            client,
            AbortSignal.timeout(10_000),
            (query) =>
                query`UPDATE mira_daytona_jobs SET lease_token=NULL,lease_expires_at=NULL WHERE id=${job.id} AND lease_token=${job.token}`
        );
    }
    return true;
}
