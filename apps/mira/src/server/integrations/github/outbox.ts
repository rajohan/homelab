import type { SQL } from "bun";

import { miraActionApproval } from "../../data/approvalPolicy";
import { codePermission, miraCodeHash, readMiraCode } from "../../data/code";
import { readCodeSource } from "../../data/codeSource";
import { MiraFailure } from "../../data/context";
import { improvementJobAllowed } from "../../improvement/policy";
import { githubBindingHash, type GitHubConfiguration } from "./configuration";
import { GitHubPublisher } from "./publisher";

const uncertain =
    "Publication was interrupted or could not be fully verified. Inspect GitHub; this attempt will not be sent again.";
const review =
    "Publication approval expired, access changed or the selected source is unavailable. Review this proposal again.";

/**
 * Recover abandoned attempts and revoke stale queued approvals without provider writes.
 * @param client - Product database.
 * @param configuration - Current explicit operator/token binding, or absent after removal.
 * @returns Completion after bounded local reconciliation; uncertain writes are never retried.
 */
export async function reconcileMiraCode(
    client: SQL,
    configuration?: GitHubConfiguration
): Promise<void> {
    await client`UPDATE mira_code_publications SET state='needs_attention',message=${uncertain},version=version+1,updated_at=now() WHERE id IN (SELECT id FROM mira_code_publications WHERE state='publishing' AND started_at<clock_timestamp()-interval '3 minutes' ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED)`;
    const rows = await client<
        { id: string; owner: string }[]
    >`SELECT id,owner FROM mira_code_publications WHERE state='queued' ORDER BY id LIMIT 50`;
    for (const candidate of rows)
        await client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${candidate.owner}`},0))`;
            const [row] = await query<
                { binding: string; control: number; fresh: boolean }[]
            >`SELECT binding_hash AS binding,control_version AS control,approved_at>clock_timestamp()-interval '15 minutes' AS fresh FROM mira_code_publications WHERE id=${candidate.id} AND state='queued' FOR UPDATE`;
            if (!row) return;
            const matches =
                configuration?.owner === candidate.owner &&
                row.binding === githubBindingHash(configuration);
            const permission = matches
                ? await codePermission(query, configuration)
                : null;
            if (
                !row.fresh ||
                !(await miraActionApproval(
                    query,
                    candidate.owner,
                    "code",
                    candidate.id
                )) ||
                permission !== row.control ||
                !(await improvementJobAllowed(query, candidate.id, "publication"))
            )
                await query`UPDATE mira_code_publications SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,message=${review},version=version+1,updated_at=now() WHERE id=${candidate.id}`;
        });
}

/**
 * Claim and publish one exact human-approved code change independently of model availability.
 * @param client - Shared durable database.
 * @param configuration - Dedicated GitHub credential; never passed to a model or sandbox.
 * @param stopping - Service shutdown/cancellation.
 * @param directory - Private selected-file volume.
 * @param request - Injectable synthetic transport for qualification.
 * @returns Whether a queued publication was handled; unknown writes remain inspectable and are never replayed.
 */
export async function dispatchMiraCode(
    client: SQL,
    configuration: GitHubConfiguration,
    stopping: AbortSignal,
    directory?: string,
    request: typeof fetch = fetch
): Promise<boolean> {
    stopping.throwIfAborted();
    const context = { client, owner: configuration.owner, actor: "mira:code" };
    const claim = await client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${configuration.owner}`},0))`;
        await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:code:dispatch',0))`;
        const permission = await codePermission(query, configuration);
        if (permission === null) return null;
        const [active] = await query<
            { id: string }[]
        >`SELECT id FROM mira_code_publications WHERE state='publishing' LIMIT 1`;
        if (active) return null;
        const [candidate] = await query<
            { id: string }[]
        >`SELECT id FROM mira_code_publications WHERE owner=${configuration.owner} AND binding_hash=${githubBindingHash(configuration)} AND state='queued' AND control_version=${permission} AND approved_at>clock_timestamp()-interval '15 minutes' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!candidate) return null;
        if (
            !(await miraActionApproval(
                query,
                configuration.owner,
                "code",
                candidate.id
            )) ||
            !(await improvementJobAllowed(query, candidate.id, "publication"))
        )
            return null;
        const row = await readMiraCode(query, context.owner, candidate.id);
        let bytes: Uint8Array;
        try {
            if (miraCodeHash(row.content) !== row.contentHash)
                throw new Error("Invalid content fingerprint.");
            const source = await readCodeSource(
                { ...context, transaction: query },
                row.content,
                row.conversationId,
                directory
            );
            bytes = source.bytes;
        } catch {
            await query`UPDATE mira_code_publications SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,message=${review},version=version+1,updated_at=now() WHERE id=${row.id}`;
            return { handled: true as const };
        }
        stopping.throwIfAborted();
        const token = crypto.randomUUID(),
            authoredAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
        const updated = await query<
            { id: string }[]
        >`UPDATE mira_code_publications SET state='publishing',attempt_token=${token},started_at=clock_timestamp(),authored_at=${authoredAt},phase=NULL,message=NULL,version=version+1,updated_at=now() WHERE id=${row.id} AND approved_at>clock_timestamp()-interval '15 minutes' RETURNING id`;
        return updated[0]
            ? { handled: false as const, row, bytes, token, authoredAt, permission }
            : null;
    });
    if (!claim) return false;
    if (claim.handled) return true;
    const signal = AbortSignal.any([stopping, AbortSignal.timeout(120_000)]);
    const guard = async () => {
        signal.throwIfAborted();
        await client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${configuration.owner}`},0))`;
            const [live] = await query<
                { id: string }[]
            >`SELECT id FROM mira_code_publications WHERE id=${claim.row.id} AND owner=${context.owner} AND state='publishing' AND attempt_token=${claim.token} AND content_hash=${claim.row.contentHash} AND binding_hash=${githubBindingHash(configuration)} AND approved_at>clock_timestamp()-interval '15 minutes' FOR UPDATE`;
            if (
                !live ||
                !(await miraActionApproval(
                    query,
                    configuration.owner,
                    "code",
                    claim.row.id
                )) ||
                !(await improvementJobAllowed(query, claim.row.id, "publication")) ||
                (await codePermission(query, configuration)) !== claim.permission
            )
                throw new MiraFailure("FORBIDDEN", "Code publication consent changed.");
            await readCodeSource(
                { ...context, transaction: query },
                claim.row.content,
                claim.row.conversationId,
                directory
            );
        });
        signal.throwIfAborted();
    };
    let result: Awaited<ReturnType<GitHubPublisher["publish"]>> | null = null;
    try {
        await guard();
        result = await new GitHubPublisher(configuration, request).publish(
            {
                id: claim.row.id,
                commit: claim.row.content.commit,
                editsSha256: claim.row.content.edits.sha256,
                title: claim.row.content.title,
                body: claim.row.content.body,
                authoredAt: claim.authoredAt,
            },
            claim.bytes,
            signal,
            guard,
            async (event) => {
                const saved = await client<
                    { id: string }[]
                >`UPDATE mira_code_publications SET phase=${`${event.phase}:${event.state}`},branch=${event.branch},tree=coalesce(${event.tree ?? null},tree),commit=coalesce(${event.commit ?? null},commit),number=coalesce(${event.number ?? null},number),version=version+1,updated_at=now() WHERE id=${claim.row.id} AND owner=${context.owner} AND attempt_token=${claim.token} AND state='publishing' RETURNING id`;
                if (!saved[0])
                    throw new Error("Publication receipt lost its owned attempt.");
            }
        );
    } catch {
        // Durable sending receipts distinguish preflight failure from uncertain external writes.
    }
    await client.begin(async (query) => {
        const [current] = await query<
            { phase: string | null }[]
        >`SELECT phase FROM mira_code_publications WHERE id=${claim.row.id} AND attempt_token=${claim.token} AND state IN ('publishing','needs_attention') FOR UPDATE`;
        if (!current) return;
        if (result)
            await query`UPDATE mira_code_publications SET state='published',phase='pull_request:confirmed',branch=${result.branch},commit=${result.commit},number=${result.number},message='Draft pull request created. GitHub checks and review are still required.',version=version+1,updated_at=now() WHERE id=${claim.row.id}`;
        else if (current.phase === null)
            await query`UPDATE mira_code_publications SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,attempt_token=NULL,started_at=NULL,authored_at=NULL,message=${review},version=version+1,updated_at=now() WHERE id=${claim.row.id}`;
        else
            await query`UPDATE mira_code_publications SET state='needs_attention',message=${uncertain},version=version+1,updated_at=now() WHERE id=${claim.row.id}`;
    });
    return true;
}

/**
 * Inspect one explicitly requested attempt using GET requests only, with bounded recovery of abandoned reads.
 * @param client - Durable product database.
 * @param configuration - Current fixed Mira credential.
 * @param stopping - Service cancellation.
 * @param request - Synthetic transport override for tests.
 * @returns Whether an inspection was claimed; observations never authorize another publication.
 */
export async function inspectMiraCodeAttempt(
    client: SQL,
    configuration: GitHubConfiguration,
    stopping: AbortSignal,
    request: typeof fetch = fetch
): Promise<boolean> {
    stopping.throwIfAborted();
    const claim = await client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${configuration.owner}`},0))`;
        if ((await codePermission(query, configuration)) === null) return null;
        const [row] = await query<
            { id: string }[]
        >`SELECT id FROM mira_code_publications WHERE owner=${configuration.owner} AND binding_hash=${githubBindingHash(configuration)} AND inspection_requested AND state IN ('published','needs_attention') AND (inspection_token IS NULL OR inspection_started_at<clock_timestamp()-interval '90 seconds') ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!row) return null;
        const token = crypto.randomUUID();
        await query`UPDATE mira_code_publications SET inspection_token=${token},inspection_started_at=clock_timestamp() WHERE id=${row.id}`;
        return { id: row.id, token };
    });
    if (!claim) return false;
    try {
        const observed = await new GitHubPublisher(
            configuration,
            request
        ).inspectPublication(
            claim.id,
            AbortSignal.any([stopping, AbortSignal.timeout(60_000)])
        );
        await client`UPDATE mira_code_publications SET observation=${JSON.stringify({ branchSha: observed.branchSha, pullRequest: observed.pullRequest })}::text::jsonb,observed_at=clock_timestamp(),inspection_requested=false,inspection_token=NULL,message='GitHub status inspected. This observation does not retry or approve publication.',version=version+1,updated_at=now() WHERE id=${claim.id} AND owner=${configuration.owner} AND inspection_token=${claim.token}`;
    } catch {
        await client`UPDATE mira_code_publications SET inspection_requested=false,inspection_token=NULL,message='GitHub inspection could not be completed. You can request another read-only inspection.',version=version+1,updated_at=now() WHERE id=${claim.id} AND owner=${configuration.owner} AND inspection_token=${claim.token}`;
    }
    return true;
}
