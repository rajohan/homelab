import {
    miraBrowserConsoleSchema,
    type miraBrowserHumanOperationSchema,
    type MiraBrowserUploadFile,
} from "@homelab/contracts/miraBrowser";
import type { TransactionSQL } from "bun";
import * as v from "valibot";

import { browserUploadFileSchema } from "../browsing/upload";
import { lockBrowserOwner, readBrowserAccess } from "./browserAccess";
import { MiraFailure, type MiraContext } from "./context";

async function choices(query: TransactionSQL, owner: string, runId: string) {
    const rows = await query<MiraBrowserUploadFile[]>`
        SELECT f.id,f.name,f.bytes AS size,f.sha256 FROM mira_attachments f
        WHERE f.owner=${owner} AND f.ready_at IS NOT NULL AND f.deleted_at IS NULL
        AND EXISTS(SELECT 1 FROM mira_runs r JOIN mira_messages m ON m.conversation_id=r.conversation_id
            WHERE r.id=${runId} AND r.owner=${owner} AND m.attachment_ids @> jsonb_build_array(f.id::text))
        ORDER BY f.created_at DESC,f.id DESC LIMIT 100`;
    return rows.filter(
        (file) =>
            v.safeParse(v.omit(browserUploadFileSchema, ["bytes"]), {
                name: file.name,
                size: file.size,
                sha256: file.sha256,
            }).success
    );
}

/**
 * List eligible attachments from this run's conversation for explicit operator selection.
 * @param context - Signed-in owner; models and automation contexts cannot select files.
 * @param input - Exact active owned browser grant.
 * @returns Immutable attachment metadata; no file content or storage paths.
 */
export async function listMiraBrowserUploads(
    context: MiraContext,
    input: unknown
): Promise<MiraBrowserUploadFile[]> {
    const { id } = v.parse(miraBrowserConsoleSchema, input);
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Only the signed-in operator can select browser uploads."
        );
    return context.client.begin(async (query) => {
        await lockBrowserOwner(query, context.owner);
        const access = await readBrowserAccess(query, context.owner, id);
        if (
            !access?.available ||
            access.state !== "active" ||
            access.controller !== "human" ||
            access.mode !== "control" ||
            access.policy?.origins.length !== 1
        )
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Take control of a browser with access to one website before selecting a file."
            );
        return choices(query, context.owner, access.runId);
    });
}

/**
 * Revalidate a human-confirmed file and exact website at queue admission and host claim.
 * @param query - Transaction holding the owner's control lock.
 * @param owner - Account fixed by the authenticated endpoint or durable host claim.
 * @param id - Current browser grant.
 * @param operation - Already parsed operator operation, never a model command.
 * @returns Completion only when all confirmed metadata still matches an eligible attachment.
 */
export async function requireBrowserUpload(
    query: TransactionSQL,
    owner: string,
    id: string,
    operation: v.InferOutput<typeof miraBrowserHumanOperationSchema>
): Promise<void> {
    if (operation.method !== "upload") throw new Error("Expected a confirmed upload.");
    const access = await readBrowserAccess(query, owner, id);
    if (
        !access?.available ||
        access.state !== "active" ||
        access.controller !== "human" ||
        access.mode !== "control" ||
        access.policy?.origins.length !== 1 ||
        access.policy.origins[0] !== operation.origin
    )
        throw new MiraFailure(
            "FORBIDDEN",
            "The confirmed upload website is no longer available."
        );
    const available = await choices(query, owner, access.runId);
    const file = available.find((item) => item.id === operation.file.id);
    if (
        !file ||
        file.name !== operation.file.name ||
        file.size !== operation.file.size ||
        file.sha256 !== operation.file.sha256
    )
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Choose a current attachment from this conversation and confirm it again."
        );
}
