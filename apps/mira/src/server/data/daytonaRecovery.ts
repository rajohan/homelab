import {
    miraDaytonaResolveSchema,
    type MiraDaytonaRecovery,
    type MiraDaytonaResolve,
    type MiraDaytonaResolution,
} from "@homelab/contracts/miraDaytona";
import * as v from "valibot";

import {
    daytonaSandboxName,
    type DaytonaBinding,
} from "../integrations/daytona/configuration";
import { auditMira, MiraFailure, type MiraContext, type MiraQuery } from "./context";
import { readMiraDaytona } from "./daytona";

async function read(
    query: MiraQuery,
    owner: string,
    id: string
): Promise<MiraDaytonaRecovery> {
    const [row] = await query<
        {
            binding: DaytonaBinding;
            sandboxId: string | null;
            state: string;
            phase: string;
            cleanup: string;
            eligibleAt: string | null;
            expired: boolean;
            leased: boolean;
            paused: boolean;
            resolution: MiraDaytonaResolution | null;
        }[]
    >`SELECT binding,sandbox_id AS "sandboxId",state,phase,cleanup,
        (deadline+interval '5 minutes')::text AS "eligibleAt",
        coalesce(deadline+interval '5 minutes'<=clock_timestamp(),false) AS expired,
        coalesce(lease_expires_at>clock_timestamp(),false) AS leased,
        EXISTS(SELECT 1 FROM mira_switches WHERE owner=${owner} AND key='integration:daytona' AND NOT enabled AND until IS NULL) AS paused,
        cleanup_resolution AS resolution FROM mira_daytona_jobs WHERE id=${id} AND owner=${owner}`;
    if (!row) throw new MiraFailure("NOT_FOUND", "Daytona job not found.");
    const sandboxName = daytonaSandboxName(row.binding, id);
    const identityHash = new Bun.CryptoHasher("sha256")
        .update(
            JSON.stringify([id, row.binding, sandboxName, row.sandboxId, row.eligibleAt])
        )
        .digest("hex");
    let blockedReason: string | null = null;
    if (
        row.cleanup !== "pending" ||
        row.phase !== "cleaning" ||
        row.state !== "needs_attention"
    )
        blockedReason = "Only unresolved sandbox cleanup can be resolved manually.";
    else if (!row.paused)
        blockedReason =
            "Pause Daytona without an automatic resume before resolving cleanup.";
    else if (!row.expired)
        blockedReason =
            "Wait until the job deadline and the five-minute recovery delay have passed.";
    else if (row.leased)
        blockedReason = "A cleanup check is running. Wait for it to finish.";
    return {
        id,
        identityHash,
        organizationId: row.binding.organizationId,
        snapshotId: row.binding.snapshotId,
        target: row.binding.target,
        sandboxId: row.sandboxId,
        sandboxName,
        eligibleAt: row.eligibleAt,
        blockedReason,
        resolution: row.resolution,
    };
}

/**
 * Read the original resource identity and recovery conditions without calling Daytona.
 * @param context - Verified owner; current provider configuration is not required.
 * @param id - Owned durable cloud job.
 * @returns Resource identity, readiness and any previous operator attestation.
 */
export async function readMiraDaytonaRecovery(
    context: MiraContext,
    id: string
): Promise<MiraDaytonaRecovery> {
    return read(context.client, context.owner, id);
}

/**
 * Record a human's external cleanup verification and release the reserved capacity.
 * @param context - Signed-in owner, never a model run or service principal.
 * @param input - Exact reviewed original resource, typed name and evidence note.
 * @returns Closed job with operator-confirmed cleanup, not provider confirmation or success.
 */
export async function resolveMiraDaytonaCleanup(
    context: MiraContext,
    input: MiraDaytonaResolve
) {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Only the operator can resolve sandbox cleanup."
        );
    const checked = v.parse(miraDaytonaResolveSchema, input);
    return context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${context.owner}`},0))`;
        await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:daytona:admission',0))`;
        await query`SELECT id FROM mira_daytona_jobs WHERE id=${checked.id} AND owner=${context.owner} FOR UPDATE`;
        const reviewed = await read(query, context.owner, checked.id);
        if (
            reviewed.identityHash !== checked.identityHash ||
            reviewed.sandboxName !== checked.sandboxName
        )
            throw new MiraFailure(
                "CONFLICT",
                "The sandbox identity changed. Close and review it again."
            );
        if (reviewed.blockedReason)
            throw new MiraFailure("PRECONDITION_FAILED", reviewed.blockedReason);
        const resolution = {
            actor: context.actor,
            reason: checked.reason,
            at: new Date().toISOString(),
        };
        await query`UPDATE mira_daytona_jobs SET cleanup='operator_confirmed',cleanup_resolution=${JSON.stringify(resolution)}::text::jsonb,phase='closed',state=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'needs_attention' END,lease_token=NULL,lease_expires_at=NULL,retry_at=NULL,version=version+1,updated_at=now(),message='The operator confirmed external cleanup. Automatic cleanup checks have stopped; execution results remain unchanged.' WHERE id=${checked.id} AND owner=${context.owner}`;
        await auditMira(query, context, "daytona.cleanup_resolved", checked.id);
        return readMiraDaytona(query, context.owner, checked.id);
    });
}
