import type { MiraDaytonaContent } from "@homelab/contracts/miraDaytona";
import type { SQL } from "bun";

import {
    MiraFailure,
    requireConversation,
    requireTask,
    type MiraQuery,
} from "../../data/context";
import {
    daytonaPermission,
    miraDaytonaHash,
    validateDaytonaInputs,
} from "../../data/daytona";
import { readMiraFile, saveMiraFile } from "../../data/files";
import {
    daytonaBindingHash,
    type DaytonaBinding,
    type DaytonaExecutionConfiguration,
} from "./configuration";
import { DaytonaClient } from "./controlPlane";
import { daytonaCommandHash, DaytonaToolbox } from "./toolbox";

interface Job {
    id: string;
    owner: string;
    binding: DaytonaBinding;
    bindingHash: string;
    content: MiraDaytonaContent;
    contentHash: string;
    conversationId: string | null;
    taskId: string | null;
    state: string;
    phase: string;
    cleanup: string;
    controlVersion: number;
    cancelRequested: boolean;
    sandboxId: string | null;
    commandId: string | null;
    uploadIndex: number;
    deleteAttempted: boolean;
    deadline: Date | null;
    outcome: string | null;
    token: string;
    files: { name: string; id: string }[];
}
const unknownMessage =
    "The provider did not confirm the operation. This attempt will not be repeated; sandbox cleanup is pending.";

async function lock(query: MiraQuery, owner: string): Promise<void> {
    await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${owner}`},0))`;
    await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:daytona:admission',0))`;
}
async function permission(
    query: MiraQuery,
    job: Job,
    configuration: DaytonaExecutionConfiguration
): Promise<void> {
    if (
        !configuration.executionQualified ||
        daytonaBindingHash(configuration) !== job.bindingHash ||
        (await daytonaPermission(query, configuration)) !== job.controlVersion
    )
        throw new MiraFailure("FORBIDDEN", "Daytona access changed.");
    await requireConversation(query, job.owner, job.conversationId);
    await requireTask(query, job.owner, job.taskId);
}
async function guard(
    query: MiraQuery,
    job: Job,
    configuration: DaytonaExecutionConfiguration
): Promise<void> {
    await permission(query, job, configuration);
    const [live] = await query<
        { id: string }[]
    >`SELECT id FROM mira_daytona_jobs WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND state='running' AND NOT cancel_requested AND deadline>clock_timestamp() FOR UPDATE`;
    if (!live)
        throw new MiraFailure("CONFLICT", "The cloud job is no longer authorized.");
}
async function update(client: SQL, job: Job, phase: string): Promise<void> {
    const [row] = await client<
        { id: string }[]
    >`UPDATE mira_daytona_jobs SET phase=${phase},version=version+1,updated_at=now() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() RETURNING id`;
    if (!row) throw new MiraFailure("CONFLICT", "Daytona lease expired.");
    job.phase = phase;
}
async function cleanup(
    client: SQL,
    job: Job,
    outcome: string,
    message: string | null
): Promise<void> {
    await client`UPDATE mira_daytona_jobs SET phase='cleaning',outcome=${outcome},message=coalesce(${message},message),version=version+1,updated_at=now() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp()`;
}

/**
 * Advance one leased cloud job independently of model and infrastructure workers.
 * @param client - Durable product database.
 * @param configuration - Current credential and qualified snapshot mapping; absence still records blocked cleanup.
 * @param stopping - Executor shutdown signal.
 * @param filesDirectory - Private shared artifact store.
 * @param request - Synthetic injectable provider transport.
 * @returns Whether one bounded phase was claimed. Unknown writes are never replayed.
 */
export async function dispatchMiraDaytona(
    client: SQL,
    configuration: DaytonaExecutionConfiguration | undefined,
    stopping: AbortSignal,
    filesDirectory?: string,
    request: typeof fetch = fetch
): Promise<boolean> {
    stopping.throwIfAborted();
    const [candidate] = await client<
        { id: string; owner: string }[]
    >`SELECT id,owner FROM mira_daytona_jobs WHERE (cleanup='pending' OR state='queued') AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) AND (retry_at IS NULL OR retry_at<=clock_timestamp()) ORDER BY CASE WHEN cleanup='pending' THEN 0 ELSE 1 END,approved_at,id LIMIT 1`;
    if (!candidate) return false;
    const claimed = await client.begin(async (query) => {
        await lock(query, candidate.owner);
        const [row] = await query<
            Omit<Job, "token">[]
        >`SELECT id,owner,binding,binding_hash AS "bindingHash",content,content_hash AS "contentHash",conversation_id AS "conversationId",task_id AS "taskId",state,phase,cleanup,control_version AS "controlVersion",cancel_requested AS "cancelRequested",sandbox_id AS "sandboxId",command_id AS "commandId",upload_index AS "uploadIndex",delete_attempted AS "deleteAttempted",deadline,outcome,files FROM mira_daytona_jobs WHERE id=${candidate.id} AND (cleanup='pending' OR state='queued') AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) FOR UPDATE`;
        if (!row) return null;
        if (row.state === "queued") {
            const [fresh] = await query<
                { fresh: boolean }[]
            >`SELECT approved_at>clock_timestamp()-interval '15 minutes' AS fresh FROM mira_daytona_jobs WHERE id=${row.id}`;
            const consent =
                configuration?.executionQualified &&
                configuration.owner === row.owner &&
                daytonaBindingHash(configuration) === row.bindingHash
                    ? await daytonaPermission(query, configuration)
                    : null;
            if (!fresh?.fresh || consent !== row.controlVersion || row.cancelRequested) {
                await query`UPDATE mira_daytona_jobs SET state=${row.cancelRequested ? "cancelled" : "draft"},approved_at=NULL,control_version=NULL,version=version+1,updated_at=now(),message='Approval expired or access changed. Review this job again.' WHERE id=${row.id}`;
                return null;
            }
            const [limit] = await query<
                { active: boolean; count: number }[]
            >`SELECT EXISTS(SELECT 1 FROM mira_daytona_jobs WHERE cleanup='pending') AS active,(SELECT count(*)::int FROM mira_daytona_jobs WHERE started_at>clock_timestamp()-interval '24 hours') AS count`;
            if (limit?.active || !limit || limit.count >= 4) {
                await query`UPDATE mira_daytona_jobs SET retry_at=clock_timestamp()+interval '30 seconds',message='Waiting for cloud capacity: one active sandbox and at most four attempts per rolling 24 hours.' WHERE id=${row.id}`;
                return null;
            }
            try {
                await requireConversation(query, row.owner, row.conversationId);
                await requireTask(query, row.owner, row.taskId);
                await validateDaytonaInputs(query, row.owner, row.content);
            } catch (error) {
                if (!(error instanceof MiraFailure)) throw error;
                await query`UPDATE mira_daytona_jobs SET state='draft',message='A linked conversation, task or input is unavailable. Review this job again.',approved_at=NULL,control_version=NULL,version=version+1 WHERE id=${row.id}`;
                return null;
            }
            // Admission survives a crash before POST. No other job can consume this slot.
            await query`UPDATE mira_daytona_jobs SET state='running',phase='admitted',cleanup='pending',started_at=clock_timestamp(),deadline=clock_timestamp()+interval '15 minutes',message=NULL WHERE id=${row.id}`;
            row.state = "running";
            row.phase = "admitted";
            row.cleanup = "pending";
            row.deadline = new Date(Date.now() + 900_000);
        }
        const token = crypto.randomUUID();
        await query`UPDATE mira_daytona_jobs SET lease_token=${token},lease_expires_at=clock_timestamp()+interval '90 seconds',retry_at=NULL WHERE id=${row.id}`;
        return { ...row, token };
    });
    if (!claimed) return false;
    const job: Job = { ...claimed, files: [...claimed.files] };
    const signal = AbortSignal.any([stopping, AbortSignal.timeout(60_000)]);
    const context = { client, owner: job.owner, actor: `daytona:${job.id}` };
    try {
        if (
            !configuration ||
            configuration.owner !== job.owner ||
            configuration.organizationId !== job.binding.organizationId
        ) {
            if (job.phase === "admitted") {
                await client`UPDATE mira_daytona_jobs SET state='cancelled',phase='closed',cleanup='confirmed',outcome='cancelled',message='Configuration was removed before a sandbox was requested.',version=version+1 WHERE id=${job.id} AND lease_token=${job.token}`;
                return true;
            }
            await client`UPDATE mira_daytona_jobs SET state='needs_attention',phase='cleaning',outcome=coalesce(outcome,'needs_attention'),message='Restore a credential for the original Daytona organization to finish cleanup.',retry_at=clock_timestamp()+interval '30 seconds',version=version+1 WHERE id=${job.id} AND lease_token=${job.token}`;
            return true;
        }
        // Cleanup uses the persisted original binding even after snapshot or region changes.
        const original = { ...job.binding, apiKey: configuration.apiKey };
        const control = new DaytonaClient(original, request);
        const reference = {
            runId: job.id,
            ...(job.sandboxId ? { sandboxId: job.sandboxId } : {}),
        };
        if (job.phase === "cleaning") {
            const found = await control.inspect(reference, signal);
            if (!found && !job.deleteAttempted) {
                await client`UPDATE mira_daytona_jobs SET state='needs_attention',message='No sandbox is visible and deletion has not been confirmed. Capacity remains reserved until the resource is reconciled.',retry_at=clock_timestamp()+interval '30 seconds',version=version+1 WHERE id=${job.id} AND lease_token=${job.token}`;
                return true;
            }
            if (found && !job.sandboxId)
                await client`UPDATE mira_daytona_jobs SET sandbox_id=${found.id} WHERE id=${job.id} AND lease_token=${job.token}`;
            let deletionAttempted = job.deleteAttempted;
            let result: "absent" | "destroyed" | "requested" =
                found?.state === "destroyed" ? "destroyed" : "absent";
            if (found && found.state !== "destroyed")
                result = await control.destroy(
                    { runId: job.id, sandboxId: found.id },
                    signal,
                    async () => {
                        const [claimed] = await client<
                            { id: string }[]
                        >`UPDATE mira_daytona_jobs SET delete_attempted=true WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp() AND phase='cleaning' RETURNING id`;
                        if (!claimed)
                            throw new MiraFailure(
                                "CONFLICT",
                                "The cleanup lease expired."
                            );
                        deletionAttempted = true;
                    }
                );
            if (result === "destroyed" || (result === "absent" && deletionAttempted))
                await client`UPDATE mira_daytona_jobs SET cleanup='confirmed',phase='closed',state=coalesce(outcome,'needs_attention'),version=version+1,updated_at=now() WHERE id=${job.id} AND lease_token=${job.token}`;
            return true;
        }
        if (["creating", "opening", "uploading", "submitting"].includes(job.phase)) {
            await cleanup(client, job, "needs_attention", unknownMessage);
            return true;
        }
        try {
            await client.begin(async (query) => {
                await lock(query, job.owner);
                await guard(query, job, configuration);
            });
        } catch (error) {
            if (!(error instanceof MiraFailure)) throw error;
            await (job.phase === "admitted"
                ? client`UPDATE mira_daytona_jobs SET state='cancelled',phase='closed',cleanup='confirmed',outcome='cancelled',message='Cancelled before a sandbox was requested.',version=version+1 WHERE id=${job.id} AND lease_token=${job.token}`
                : cleanup(
                      client,
                      job,
                      "cancelled",
                      "Stopped because the job was cancelled, expired or access changed."
                  ));
            return true;
        }
        if (miraDaytonaHash(job.content) !== job.contentHash)
            throw new Error("Daytona proposal fingerprint mismatch.");
        const authorize = (phase: string) => async () => {
            signal.throwIfAborted();
            const previous = job.phase;
            await client.begin(async (query) => {
                await lock(query, job.owner);
                await guard(query, job, configuration);
                job.phase = phase;
                const [row] = await query<
                    { id: string }[]
                >`UPDATE mira_daytona_jobs SET phase=${phase},version=version+1,updated_at=now() WHERE id=${job.id} AND lease_token=${job.token} AND phase=${previous} RETURNING id`;
                if (!row) throw new MiraFailure("CONFLICT", "The cloud phase changed.");
            });
            job.phase = phase;
        };
        if (job.phase === "admitted") {
            const observed = await control.create(job.id, signal, authorize("creating"));
            const [saved] = await client<
                { id: string }[]
            >`UPDATE mira_daytona_jobs SET sandbox_id=${observed.id},phase='waiting',version=version+1,updated_at=now() WHERE id=${job.id} AND lease_token=${job.token} AND phase='creating' AND lease_expires_at>clock_timestamp() RETURNING id`;
            if (!saved) throw new Error("Could not record sandbox receipt.");
            return true;
        }
        if (!job.sandboxId) throw new Error("Missing sandbox receipt.");
        const toolbox = new DaytonaToolbox(
            original,
            { runId: job.id, sandboxId: job.sandboxId },
            request
        );
        if (job.phase === "waiting") {
            const observed = await control.inspect(reference, signal);
            if (!observed || !observed.settingsMatch)
                throw new Error("Sandbox settings unavailable.");
            if (observed.state !== "started") return true;
            await toolbox.open(signal, authorize("opening"));
            await update(client, job, "inputs");
            return true;
        }
        if (job.phase === "inputs") {
            const selected = job.content.inputs[job.uploadIndex];
            if (selected) {
                const file = await readMiraFile(context, filesDirectory, selected.id);
                if (
                    file.bytes.length > 1_048_576 ||
                    new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex") !==
                        selected.sha256
                )
                    throw new Error("Input file no longer matches approval.");
                await toolbox.upload(selected.name, file.bytes, signal, async () => {
                    await client.begin(async (query) => {
                        await lock(query, job.owner);
                        await validateDaytonaInputs(query, job.owner, job.content);
                    });
                    await authorize("uploading")();
                });
                await client`UPDATE mira_daytona_jobs SET upload_index=upload_index+1,phase='inputs',version=version+1,updated_at=now() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp()`;
            } else await update(client, job, "ready");
            return true;
        }
        if (job.phase === "ready") {
            const commandId = await toolbox.submit(
                job.content.command,
                signal,
                authorize("submitting")
            );
            await client`UPDATE mira_daytona_jobs SET command_id=${commandId},phase='executing',version=version+1,updated_at=now() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp()`;
            return true;
        }
        if (job.phase === "executing") {
            if (!job.commandId) throw new Error("Missing command receipt.");
            const hash = daytonaCommandHash(job.content.command);
            const observed = await toolbox.inspect(hash, signal, job.commandId);
            if (observed.state !== "running" && observed.state !== "completed")
                throw new Error("Command identity unavailable.");
            try {
                const logs = await toolbox.logs(hash, job.commandId, signal);
                await client`UPDATE mira_daytona_jobs SET stdout=${logs.stdout},stderr=${logs.stderr},output=${logs.output},updated_at=now() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp()`;
            } catch {
                signal.throwIfAborted();
                await client`UPDATE mira_daytona_jobs SET message='Logs are unavailable or exceeded the 128 KiB limit. Displayed logs may be incomplete.' WHERE id=${job.id} AND lease_token=${job.token}`;
            }
            if (observed.state === "completed")
                await client`UPDATE mira_daytona_jobs SET exit_code=${observed.exitCode},outcome=${observed.exitCode === 0 ? "completed" : "failed"},phase='collecting',version=version+1,updated_at=now() WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp()`;
            return true;
        }
        if (job.phase === "collecting") {
            const name = job.content.outputs.find(
                (value) => !job.files.some((file) => file.name === value)
            );
            if (!name) {
                await cleanup(client, job, job.outcome ?? "needs_attention", null);
                return true;
            }
            const bytes = await toolbox.download(name, signal);
            if (!bytes) throw new Error("A selected output is missing.");
            const hex = new Bun.CryptoHasher("sha256")
                .update(JSON.stringify(["daytona-output-v1", job.id, name]))
                .digest("hex");
            const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
            await saveMiraFile(
                context,
                filesDirectory,
                { id, name, bytes },
                async (query) => {
                    await guard(query, job, configuration);
                    await query`UPDATE mira_daytona_jobs SET files=CASE WHEN files @> ${JSON.stringify([{ name, id }])}::text::jsonb THEN files ELSE files || ${JSON.stringify([{ name, id }])}::text::jsonb END,version=version+1,updated_at=now() WHERE id=${job.id} AND lease_token=${job.token} AND phase='collecting'`;
                }
            );
            return true;
        }
        throw new Error("Unsupported cloud job phase.");
    } catch {
        // Transport/provider diagnostics may contain private inputs. Store a fixed public message.
        if (job.phase === "admitted") {
            await client`UPDATE mira_daytona_jobs SET state='failed',phase='closed',cleanup='confirmed',outcome='failed',message='Preflight failed before creating a sandbox.',version=version+1 WHERE id=${job.id} AND lease_token=${job.token} AND lease_expires_at>clock_timestamp()`;
        } else if (job.phase === "cleaning") {
            await client`UPDATE mira_daytona_jobs SET state='needs_attention',message='Sandbox cleanup could not be confirmed. Mira will keep checking.',retry_at=clock_timestamp()+interval '30 seconds',version=version+1 WHERE id=${job.id} AND lease_token=${job.token}`;
        } else await cleanup(client, job, "needs_attention", unknownMessage);
    } finally {
        await client`UPDATE mira_daytona_jobs SET lease_token=NULL,lease_expires_at=NULL WHERE id=${job.id} AND lease_token=${job.token}`;
    }
    return true;
}
