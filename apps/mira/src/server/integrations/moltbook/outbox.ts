import {
    miraSocialContentSchema,
    type MiraSocialContent,
} from "@homelab/contracts/miraSocial";
import { publishNotification } from "@homelab/notifications";
import type { SQL } from "bun";
import * as v from "valibot";

import { miraActionApproval } from "../../data/approvalPolicy";
import { MiraFailure } from "../../data/context";
import { miraSocialHash, socialPermission } from "../../data/social";
import { moltbookBindingHash, type MoltbookReadConfiguration } from "./configuration";
import {
    MoltbookPublisher,
    MoltbookRateLimit,
    type MoltbookWriteReceipt,
} from "./publisher";

const uncertain =
    "Moltbook did not confirm this attempt. Inspect the known content before trying again; Mira will not repeat it automatically.";
const review = "Approval expired or Moltbook access changed. Review this draft again.";
/**
 * Recover abandoned provider requests and retire stale consent without repeating external writes.
 * @param client - Durable product database.
 * @param configuration - Current executor account, absent when provisioning was removed.
 * @returns Completion after bounded recovery and expiry checks.
 */
export async function reconcileMiraSocial(
    client: SQL,
    configuration?: MoltbookReadConfiguration
): Promise<void> {
    await client.begin(async (query) => {
        const rows = await query<
            { id: string; owner: string; token: string }[]
        >`UPDATE mira_social_drafts SET state='needs_attention',answer=NULL,verification_code=NULL,message=${uncertain},version=version+1,updated_at=now() WHERE id IN (SELECT id FROM mira_social_drafts WHERE state IN ('publishing','verifying') AND started_at<clock_timestamp()-interval '2 minutes' ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING id,owner,attempt_token AS token`;
        for (const row of rows)
            await publishNotification(
                query,
                "mira-social",
                {
                    key: `${row.id}:${row.token}`,
                    title: "Moltbook submission needs review",
                    message: uncertain,
                    severity: "warning",
                    destination: "mira",
                },
                `human:${row.owner}`
            );
    });
    const candidates = await client<
        { id: string; owner: string }[]
    >`SELECT id,owner FROM mira_social_drafts WHERE state IN ('queued','verification_required','queued_verification') ORDER BY approved_at,id LIMIT 50`;
    for (const candidate of candidates)
        await client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${candidate.owner}`},0))`;
            const [row] = await query<
                {
                    state: string;
                    binding: string;
                    stamp: string;
                    fresh: boolean;
                    live: boolean;
                }[]
            >`SELECT state,binding_hash AS binding,control_stamp AS stamp,approved_at>clock_timestamp()-interval '15 minutes' AS fresh,expires_at>clock_timestamp() AS live FROM mira_social_drafts WHERE id=${candidate.id} AND owner=${candidate.owner} AND state IN ('queued','verification_required','queued_verification') FOR UPDATE`;
            if (!row) return;
            const matches =
                configuration?.owner === candidate.owner &&
                configuration.publishApiKey &&
                row.binding === moltbookBindingHash(configuration);
            // A displayed challenge awaits fresh human consent, not another model write.
            const delegated =
                row.state === "verification_required" ||
                (await miraActionApproval(
                    query,
                    candidate.owner,
                    "social",
                    candidate.id
                ));
            const stamp = matches ? await socialPermission(query, configuration) : null;
            if (
                delegated &&
                row.fresh &&
                stamp === row.stamp &&
                (row.state === "queued" || row.live)
            )
                return;
            await (row.state === "queued"
                ? query`UPDATE mira_social_drafts SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_stamp=NULL,retry_after=NULL,message=${review},version=version+1,updated_at=now() WHERE id=${candidate.id}`
                : query`UPDATE mira_social_drafts SET state='needs_attention',answer=NULL,verification_code=NULL,message='Verification expired or access changed. Existing content was not reposted. Inspect it in Moltbook.',version=version+1,updated_at=now() WHERE id=${candidate.id}`);
        });
}
/**
 * Dispatch one approved post, reply or explicit verification answer independently of model availability.
 * @param client - Durable product database and queue.
 * @param configuration - Operator-owned identity and separate publication credential.
 * @param stopping - Service shutdown cancellation.
 * @param request - Transport injectable for synthetic qualification only.
 * @returns Whether a durable attempt was claimed; uncertain mutations are never replayed.
 */
export async function dispatchMiraSocial(
    client: SQL,
    configuration: MoltbookReadConfiguration,
    stopping: AbortSignal,
    request: typeof fetch = fetch
): Promise<boolean> {
    stopping.throwIfAborted();
    if (!configuration.publishApiKey) return false;
    const hash = moltbookBindingHash(configuration);
    const [candidate] = await client<
        {
            id: string;
            version: number;
            state: string;
            content: MiraSocialContent;
            hash: string;
            stamp: string;
        }[]
    >`SELECT id,version,state,content,content_hash AS hash,control_stamp AS stamp FROM mira_social_drafts WHERE owner=${configuration.owner} AND binding_hash=${hash} AND state IN ('queued','queued_verification') AND approved_at>clock_timestamp()-interval '15 minutes' AND (retry_after IS NULL OR retry_after<=clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM mira_social_drafts active WHERE active.owner=${configuration.owner} AND active.state IN ('publishing','verifying')) AND NOT EXISTS(SELECT 1 FROM mira_social_cooldowns WHERE owner=${configuration.owner} AND until>clock_timestamp()) ORDER BY CASE WHEN state='queued_verification' THEN 0 ELSE 1 END,approved_at,id LIMIT 1`;
    if (!candidate || (await socialPermission(client, configuration)) !== candidate.stamp)
        return false;
    const content = v.parse(miraSocialContentSchema, candidate.content);
    if (miraSocialHash(content) !== candidate.hash)
        throw new Error("Moltbook draft fingerprint changed.");
    const publisher = new MoltbookPublisher(configuration, request);
    try {
        await publisher.preflight(
            AbortSignal.any([stopping, AbortSignal.timeout(15_000)])
        );
    } catch {
        stopping.throwIfAborted();
        await client`UPDATE mira_social_drafts SET retry_after=clock_timestamp()+interval '30 seconds' WHERE id=${candidate.id} AND version=${candidate.version} AND state=${candidate.state}`;
        return false;
    }
    const claimed = await client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${configuration.owner}`},0))`;
        const [active] = await query<
            { id: string }[]
        >`SELECT id FROM mira_social_drafts WHERE owner=${configuration.owner} AND state IN ('publishing','verifying') LIMIT 1`;
        if (
            active ||
            !(await miraActionApproval(
                query,
                configuration.owner,
                "social",
                candidate.id
            )) ||
            (await socialPermission(query, configuration)) !== candidate.stamp
        )
            return null;
        const token = crypto.randomUUID();
        const [row] = await query<
            { code: string | null; answer: string | null; providerId: string | null }[]
        >`UPDATE mira_social_drafts SET state=${candidate.state === "queued" ? "publishing" : "verifying"},attempt_token=${token},started_at=clock_timestamp(),message=NULL,retry_after=NULL,version=version+1,updated_at=now() WHERE id=${candidate.id} AND owner=${configuration.owner} AND version=${candidate.version} AND state=${candidate.state} AND content_hash=${candidate.hash} AND approved_at>clock_timestamp()-interval '15 minutes' AND (state='queued' OR expires_at>clock_timestamp()) AND NOT EXISTS(SELECT 1 FROM mira_social_cooldowns WHERE owner=${configuration.owner} AND until>clock_timestamp()) RETURNING verification_code AS code,answer,provider_id AS "providerId"`;
        return row ? { ...row, token } : null;
    });
    if (!claimed) return false;
    const verifying = candidate.state === "queued_verification";
    const signal = AbortSignal.any([stopping, AbortSignal.timeout(30_000)]);
    let writeAllowed = false;
    const guard = async () => {
        signal.throwIfAborted();
        await client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${configuration.owner}`},0))`;
            const [row] = await query<
                { id: string }[]
            >`SELECT id FROM mira_social_drafts WHERE id=${candidate.id} AND owner=${configuration.owner} AND attempt_token=${claimed.token} AND state=${verifying ? "verifying" : "publishing"} AND content_hash=${candidate.hash} AND approved_at>clock_timestamp()-interval '15 minutes' AND (${!verifying} OR expires_at>clock_timestamp()) FOR UPDATE`;
            if (
                !row ||
                !(await miraActionApproval(
                    query,
                    configuration.owner,
                    "social",
                    candidate.id
                )) ||
                (await socialPermission(query, configuration)) !== candidate.stamp
            )
                throw new MiraFailure("FORBIDDEN", "Moltbook consent changed.");
        });
        signal.throwIfAborted();
        writeAllowed = true;
    };
    let receipt: MoltbookWriteReceipt | null = null;
    let verified = false,
        limited: MoltbookRateLimit | null = null;
    try {
        if (verifying) {
            if (!claimed.code || !claimed.answer || !claimed.providerId)
                throw new Error("Verification context missing.");
            await publisher.verify(
                {
                    code: claimed.code,
                    answer: claimed.answer,
                    id: claimed.providerId,
                    kind: content.kind,
                },
                signal,
                guard
            );
            verified = true;
        } else receipt = await publisher.create(content, signal, guard);
    } catch (error) {
        if (error instanceof MoltbookRateLimit) limited = error;
    }
    await client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${configuration.owner}`},0))`;
        if (!writeAllowed && !verifying) {
            await query`UPDATE mira_social_drafts SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_stamp=NULL,attempt_token=NULL,started_at=NULL,message=${review},version=version+1,updated_at=now() WHERE id=${candidate.id} AND owner=${configuration.owner} AND attempt_token=${claimed.token} AND state='publishing'`;
            return;
        }
        if (limited)
            await query`INSERT INTO mira_social_cooldowns(owner,until) VALUES(${configuration.owner},${limited.retryAt}) ON CONFLICT(owner) DO UPDATE SET until=GREATEST(mira_social_cooldowns.until,EXCLUDED.until)`;
        if (limited && !verifying) {
            await query`UPDATE mira_social_drafts SET state='queued',retry_after=${limited.retryAt},message='Moltbook rate limit reached. Delivery will wait while this approval remains valid.',version=version+1,updated_at=now() WHERE id=${candidate.id} AND owner=${configuration.owner} AND attempt_token=${claimed.token} AND state='publishing'`;
            return;
        }
        let state = verified ? "submitted" : (receipt?.status ?? "needs_attention");
        if (
            receipt?.verification &&
            new Date(receipt.verification.expiresAt).getTime() <= Date.now()
        )
            state = "needs_attention";
        let message = uncertain;
        if (state === "submitted")
            message =
                "Moltbook accepted this content. Moderation may still affect its visibility.";
        if (state === "verification_required")
            message =
                "Moltbook requires verification before publishing this content. Submit the displayed challenge answer before it expires.";
        const saved = await query<
            { id: string }[]
        >`UPDATE mira_social_drafts SET state=${state},provider_id=COALESCE(${receipt?.id ?? null},provider_id),verification_code=${state === "verification_required" ? (receipt?.verification?.code ?? null) : null},challenge=${receipt?.verification?.challenge ?? null},expires_at=${receipt?.verification ? new Date(receipt.verification.expiresAt) : null},answer=NULL,message=${message},version=version+1,updated_at=now() WHERE id=${candidate.id} AND owner=${configuration.owner} AND attempt_token=${claimed.token} AND state IN ('publishing','verifying','needs_attention') RETURNING id`;
        if (saved[0] && state !== "submitted")
            await publishNotification(
                query,
                "mira-social",
                {
                    key: `${candidate.id}:${claimed.token}`,
                    title:
                        state === "verification_required"
                            ? "Moltbook verification required"
                            : "Moltbook submission needs review",
                    message,
                    severity: "warning",
                    destination: "mira",
                },
                `human:${configuration.owner}`
            );
    });
    return true;
}
