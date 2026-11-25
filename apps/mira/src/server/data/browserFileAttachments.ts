import {
    miraBrowserAttachSchema,
    type MiraBrowserUploadFile,
} from "@homelab/contracts/miraBrowser";
import type { TransactionSQL } from "bun";
import * as v from "valibot";

import { browserUploadAttachmentSchema } from "../browsing/upload";
import { lockBrowserOwner, readBrowserAccess } from "./browserAccess";
import { auditMira, type MiraContext, MiraFailure } from "./context";

/** Link an owned file to the active conversation alongside this browser run's other attachments.
 * @param query - Transaction holding the owner's browser controls lock.
 * @param owner - Authenticated account for the run and conversation.
 * @param runId - Exact run selected through the browser grant.
 * @param fileId - Attachment whose readiness and ownership the caller has checked in this transaction.
 * @returns Completion once the attachment is linked, including an identical retry.
 */
export async function linkBrowserAttachment(
    query: TransactionSQL,
    owner: string,
    runId: string,
    fileId: string
) {
    const ids = JSON.stringify([fileId]);
    const linked = await query<{ id: string }[]>`
        UPDATE mira_messages m SET attachment_ids=CASE WHEN attachment_ids @> ${ids}::text::jsonb
            THEN attachment_ids ELSE attachment_ids||${ids}::text::jsonb END
        FROM mira_runs r JOIN mira_conversations c ON c.id=r.conversation_id AND c.owner=r.owner
        WHERE r.id=${runId} AND r.owner=${owner} AND c.deleted_at IS NULL
        AND m.id=r.assistant_message_id AND m.conversation_id=c.id
        AND (jsonb_array_length(m.attachment_ids)<100 OR m.attachment_ids @> ${ids}::text::jsonb)
        RETURNING m.id`;
    if (linked.length !== 1)
        throw new MiraFailure(
            "CONFLICT",
            "This response is unavailable or already contains 100 files."
        );
}

/** Add a selected local file to the chat before its separate, site-specific upload.
 * @param context - Freshly verified operator and product database.
 * @param input - Current browser, its control generation and the chosen owned file.
 * @returns The immutable file identity and digest to confirm at the upload boundary.
 */
export async function attachMiraBrowserFile(
    context: MiraContext,
    input: unknown
): Promise<MiraBrowserUploadFile> {
    const { id, epoch, fileId } = v.parse(miraBrowserAttachSchema, input);
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure("FORBIDDEN", "Only the signed-in operator can add files.");
    return context.client.begin(async (query) => {
        await lockBrowserOwner(query, context.owner);
        const access = await readBrowserAccess(query, context.owner, id);
        if (
            !access?.available ||
            access.state !== "active" ||
            access.mode !== "control" ||
            access.controller !== "human" ||
            access.policy?.origins.length !== 1
        )
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Take control of the browser before adding a file."
            );
        const [console] = await query<
            { id: string }[]
        >`SELECT access_id AS id FROM mira_browser_consoles WHERE access_id=${id} AND epoch=${epoch} AND controller='human' FOR SHARE`;
        if (!console)
            throw new MiraFailure(
                "CONFLICT",
                "Browser control changed. Choose the file again."
            );
        const [file] = await query<
            MiraBrowserUploadFile[]
        >`SELECT id,name,bytes AS size,sha256 FROM mira_attachments WHERE id=${fileId} AND owner=${context.owner} AND ready_at IS NOT NULL AND deleted_at IS NULL FOR SHARE`;
        if (!file)
            throw new MiraFailure("NOT_FOUND", "The selected attachment is unavailable.");
        if (!v.is(browserUploadAttachmentSchema, file))
            throw new MiraFailure(
                "BAD_REQUEST",
                "The file name or size cannot be used in the browser."
            );
        await linkBrowserAttachment(query, context.owner, access.runId, file.id);
        await auditMira(query, context, "browser.file_attached", file.id);
        return file;
    });
}
