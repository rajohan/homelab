import {
    miraPublicationContentSchema,
    type MiraPublicationContent,
} from "@homelab/contracts/miraPublication";
import { publishNotification } from "@homelab/notifications";
import type { SQL } from "bun";
import * as v from "valibot";

import { miraActionApproval } from "../../data/approvalPolicy";
import { MiraFailure } from "../../data/context";
import { hereNowBindingCurrent } from "../../data/herenow";
import {
    readPublicationFiles,
    verifyPublicationFiles,
} from "../../data/publicationFiles";
import { miraPublicationHash, publicationPermission } from "../../data/publications";
import { hereNowBindingHash, type HereNowReadConfiguration } from "./configuration";
import { HereNowPublisher, PublicationConflict } from "./publisher";

const uncertainMessage =
    "Publication could not be fully confirmed. Inspect the known site in here.now before trying again; this attempt will not be repeated automatically.";
const reviewMessage =
    "Publication approval expired or here.now access changed. Review this draft again before publishing.";

/**
 * Recover interrupted publications and revoke stale queued approvals without provider calls.
 * @param client - Durable product database.
 * @param configuration - Current provisioned account and optional publishing credential.
 * @returns Completion after bounded reconciliation; ambiguous external writes are never replayed.
 */
export async function reconcileMiraPublications(
    client: SQL,
    configuration?: HereNowReadConfiguration
): Promise<void> {
    await client.begin(async (query) => {
        const abandoned = await query<
            { id: string; owner: string; token: string }[]
        >`UPDATE mira_publications SET state='needs_attention',message=${uncertainMessage},version=version+1,updated_at=now() WHERE id IN (SELECT id FROM mira_publications WHERE state='publishing' AND started_at<clock_timestamp()-interval '3 minutes' ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING id,owner,attempt_token AS token`;
        for (const row of abandoned)
            await publishNotification(
                query,
                "mira-publication",
                {
                    key: `${row.id}:${row.token}`,
                    title: "Publication needs review",
                    message: uncertainMessage,
                    severity: "warning",
                    destination: "mira",
                },
                `human:${row.owner}`
            );
    });
    const hash = configuration ? hereNowBindingHash(configuration) : null;
    const candidates = await client<
        { id: string; owner: string }[]
    >`SELECT id,owner FROM mira_publications WHERE state='queued' OR (state='draft' AND EXISTS(SELECT 1 FROM mira_integration_receivers WHERE key='here-now' AND binding_hash IS DISTINCT FROM mira_publications.binding_hash)) ORDER BY approved_at NULLS LAST,id LIMIT 50`;
    for (const candidate of candidates) {
        await client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${candidate.owner}`},0))`;
            const [row] = await query<
                {
                    state: string;
                    binding: string;
                    control: number | null;
                    fresh: boolean;
                }[]
            >`SELECT state,binding_hash AS binding,control_version AS control,approved_at>clock_timestamp()-interval '15 minutes' AS fresh FROM mira_publications WHERE id=${candidate.id} AND owner=${candidate.owner} AND state IN ('draft','queued') FOR UPDATE`;
            if (!row) return;
            const [receiver] = await query<
                { binding: string | null }[]
            >`SELECT binding_hash AS binding FROM mira_integration_receivers WHERE key='here-now' FOR SHARE`;
            const matches =
                configuration?.owner === candidate.owner && row.binding === hash;
            if (receiver ? receiver.binding !== row.binding : !matches) {
                await query`UPDATE mira_publications SET state='cancelled',message='The here.now account changed or was removed. Create a new draft for the current account.',version=version+1,updated_at=now() WHERE id=${candidate.id}`;
                return;
            }
            if (row.state !== "queued") return;
            const [control] = await query<
                { enabled: boolean; version: number; binding: string | null }[]
            >`SELECT enabled,version,binding_hash AS binding FROM mira_switches WHERE owner=${candidate.owner} AND key='integration:here-now'`;
            if (
                !row.fresh ||
                !(await miraActionApproval(
                    query,
                    candidate.owner,
                    "publication",
                    candidate.id
                )) ||
                !control?.enabled ||
                control.version !== row.control ||
                control.binding !== row.binding ||
                !configuration ||
                (matches && !configuration.publishApiKey)
            )
                await query`UPDATE mira_publications SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,retry_after=NULL,message=${reviewMessage},version=version+1,updated_at=now() WHERE id=${candidate.id}`;
        });
    }
}

/**
 * Attempt one exact human-approved publication independently of model availability.
 * @param client - Durable pool shared with draft approval and recovery.
 * @param configuration - Fixed account and publishing credential; never model-selected.
 * @param stopping - Service shutdown cancellation.
 * @param directory - Private local file store containing the selected approved files.
 * @param request - HTTP transport, injectable only for synthetic qualification.
 * @returns Whether a publication was claimed; a claimed attempt has a durable terminal outcome.
 */
export async function dispatchMiraPublication(
    client: SQL,
    configuration: HereNowReadConfiguration,
    stopping: AbortSignal,
    directory?: string,
    request: typeof fetch = fetch
): Promise<boolean> {
    stopping.throwIfAborted();
    if (!configuration.publishApiKey) return false;
    const [candidate] = await client<
        {
            id: string;
            version: number;
            control: number;
            content: MiraPublicationContent;
            hash: string;
        }[]
    >`SELECT id,version,control_version AS control,content,content_hash AS hash FROM mira_publications WHERE owner=${configuration.owner} AND binding_hash=${hereNowBindingHash(configuration)} AND state='queued' AND NOT EXISTS(SELECT 1 FROM mira_publications active WHERE active.owner=${configuration.owner} AND active.state='publishing') AND approved_at>clock_timestamp()-interval '15 minutes' AND (retry_after IS NULL OR retry_after<=clock_timestamp()) ORDER BY id LIMIT 1`;
    if (
        !candidate ||
        (await publicationPermission(client, configuration)) !== candidate.control
    )
        return false;
    const content = v.parse(miraPublicationContentSchema, candidate.content);
    if (miraPublicationHash(content) !== candidate.hash)
        throw new Error("Publication fingerprint differs from stored content.");
    const publisher = new HereNowPublisher(configuration, request);
    try {
        await publisher.preflight(
            content,
            AbortSignal.any([stopping, AbortSignal.timeout(60_000)])
        );
    } catch (error) {
        stopping.throwIfAborted();
        await (error instanceof PublicationConflict
            ? client`UPDATE mira_publications SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,message=${error.message},version=version+1,updated_at=now() WHERE id=${candidate.id} AND version=${candidate.version} AND state='queued'`
            : client`UPDATE mira_publications SET retry_after=clock_timestamp()+interval '30 seconds' WHERE id=${candidate.id} AND version=${candidate.version} AND state='queued'`);
        return false;
    }
    const context = { client, owner: configuration.owner, actor: "mira:publication" };
    const claimed = await client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${configuration.owner}`},0))`;
        const [active] = await query<
            { id: string }[]
        >`SELECT id FROM mira_publications WHERE owner=${configuration.owner} AND state='publishing' LIMIT 1`;
        if (active) return null;
        const [row] = await query<
            { control: number; fresh: boolean }[]
        >`SELECT control_version AS control,approved_at>clock_timestamp()-interval '15 minutes' AS fresh FROM mira_publications WHERE id=${candidate.id} AND owner=${configuration.owner} AND version=${candidate.version} AND content_hash=${candidate.hash} AND binding_hash=${hereNowBindingHash(configuration)} AND state='queued' FOR UPDATE`;
        if (!row) return null;
        const control = await publicationPermission(query, configuration);
        if (
            !(await miraActionApproval(
                query,
                configuration.owner,
                "publication",
                candidate.id
            )) ||
            !row.fresh ||
            control === null ||
            control !== row.control
        )
            return null;
        let bytes: Uint8Array[];
        try {
            bytes = await readPublicationFiles(
                { ...context, transaction: query },
                directory,
                content.files
            );
        } catch {
            await query`UPDATE mira_publications SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,message='The selected files could not be verified. Save and review the draft again.',version=version+1,updated_at=now() WHERE id=${candidate.id}`;
            return null;
        }
        stopping.throwIfAborted();
        const token = crypto.randomUUID();
        const updated = await query<
            { id: string }[]
        >`UPDATE mira_publications SET state='publishing',phase='creating version',attempt_token=${token},started_at=clock_timestamp(),retry_after=NULL,message=NULL,version=version+1,updated_at=now() WHERE id=${candidate.id} AND approved_at>clock_timestamp()-interval '15 minutes' RETURNING id`;
        if (!updated[0]) return null;
        return { token, control, bytes };
    });
    if (!claimed) return false;
    if (stopping.aborted) {
        await client`UPDATE mira_publications SET state='queued',attempt_token=NULL,started_at=NULL,phase=NULL,version=version+1,updated_at=now() WHERE id=${candidate.id} AND attempt_token=${claimed.token} AND state='publishing'`;
        return true;
    }
    const signal = AbortSignal.any([stopping, AbortSignal.timeout(120_000)]);
    let writeAllowed = false;
    const guard = async () => {
        signal.throwIfAborted();
        await client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${configuration.owner}`},0))`;
            const [row] = await query<
                { id: string }[]
            >`SELECT id FROM mira_publications WHERE id=${candidate.id} AND owner=${configuration.owner} AND attempt_token=${claimed.token} AND state='publishing' AND content_hash=${candidate.hash} AND approved_at>clock_timestamp()-interval '15 minutes' FOR UPDATE`;
            if (
                !row ||
                !(await miraActionApproval(
                    query,
                    configuration.owner,
                    "publication",
                    candidate.id
                )) ||
                (await publicationPermission(query, configuration)) !== claimed.control ||
                !(await hereNowBindingCurrent(query, configuration))
            )
                throw new MiraFailure("FORBIDDEN", "Publication consent changed.");
            await verifyPublicationFiles(
                query,
                { ...context, transaction: query },
                content.files
            );
        });
        signal.throwIfAborted();
        writeAllowed = true;
    };
    let result: { slug: string; versionId: string; expiresAt: string | null } | null =
        null;
    try {
        result = await publisher.publish(
            content,
            claimed.bytes,
            signal,
            guard,
            async (phase, slug, versionId) => {
                const saved = await client<
                    { id: string }[]
                >`UPDATE mira_publications SET phase=${phase},slug=${slug},provider_version_id=${versionId},version=version+1,updated_at=now() WHERE id=${candidate.id} AND owner=${configuration.owner} AND attempt_token=${claimed.token} AND state IN ('publishing','needs_attention') RETURNING id`;
                if (!saved[0])
                    throw new Error("Publication attempt no longer owns its receipt.");
            }
        );
    } catch {
        /* Retain known references and require inspection for every uncertain write. */
    }
    await client.begin(async (query) => {
        if (!writeAllowed) {
            await query`UPDATE mira_publications SET state='draft',approval_run_id=NULL,approved_version=NULL,approved_by=NULL,approved_at=NULL,control_version=NULL,attempt_token=NULL,started_at=NULL,phase=NULL,message=${reviewMessage},version=version+1,updated_at=now() WHERE id=${candidate.id} AND owner=${configuration.owner} AND attempt_token=${claimed.token} AND state='publishing'`;
            return;
        }
        let message = uncertainMessage;
        if (result)
            message = result.expiresAt
                ? `Published. Existing expiry: ${result.expiresAt}.`
                : "Published and verified. Anyone with the link can view these files.";
        const saved = await query<
            { id: string }[]
        >`UPDATE mira_publications SET state=${result ? "published" : "needs_attention"},phase=NULL,message=${message},version=version+1,updated_at=now() WHERE id=${candidate.id} AND owner=${configuration.owner} AND attempt_token=${claimed.token} AND state IN ('publishing','needs_attention') RETURNING id`;
        if (saved[0] && !result)
            await publishNotification(
                query,
                "mira-publication",
                {
                    key: `${candidate.id}:${claimed.token}`,
                    title: "Publication needs review",
                    message: uncertainMessage,
                    severity: "warning",
                    destination: "mira",
                },
                `human:${configuration.owner}`
            );
    });
    return true;
}
