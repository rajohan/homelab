import type { MiraMailAttachment, MiraMailContent } from "@homelab/contracts/miraMail";

import { MiraFailure, type MiraContext, type MiraQuery } from "./context";
import { readMiraFile } from "./files";

/**
 * Snapshot only owned, ready files, restricting model drafts to files shared in their chat.
 * @param query - Draft transaction; shared row locks serialize file revocation.
 * @param context - Verified operator or leased assistant context.
 * @param ids - At most five unique product file identities.
 * @param conversationId - Model's current owned conversation, never another file library.
 * @returns Immutable display metadata and content digests for the approval fingerprint.
 */
export async function captureMailAttachments(
    query: MiraQuery,
    context: MiraContext,
    ids: string[],
    conversationId: string | null
): Promise<MiraMailAttachment[]> {
    if (ids.length > 5 || new Set(ids).size !== ids.length)
        throw new MiraFailure("BAD_REQUEST", "Choose at most five different files.");
    const snapshots: MiraMailAttachment[] = [];
    for (const id of ids) {
        const [file] = await query<
            MiraMailAttachment[]
        >`SELECT id,name,media_type AS "mediaType",bytes,sha256 FROM mira_attachments WHERE id=${id} AND owner=${context.owner} AND deleted_at IS NULL AND ready_at IS NOT NULL FOR SHARE`;
        if (!file)
            throw new MiraFailure(
                "NOT_FOUND",
                "An email attachment is no longer available."
            );
        if (context.run) {
            const linked = await query<
                { id: string }[]
            >`SELECT id FROM mira_messages WHERE conversation_id=${conversationId} AND attachment_ids @> ${JSON.stringify([id])}::text::jsonb LIMIT 1`;
            if (!linked[0])
                throw new MiraFailure(
                    "FORBIDDEN",
                    "Only files shared in this conversation can be proposed as email attachments."
                );
        }
        snapshots.push(file);
    }
    if (snapshots.reduce((total, file) => total + file.bytes, 0) > 4 * 1024 * 1024)
        throw new MiraFailure(
            "BAD_REQUEST",
            "Email attachments must total no more than 4 MiB."
        );
    return snapshots;
}

/**
 * Verify that approved snapshots still identify the same live owned file metadata.
 * @param query - Approval or dispatch transaction.
 * @param context - Verified owner; human grants are checked separately.
 * @param snapshots - Immutable metadata included in the approved content hash.
 * @returns Completion with file rows locked until admission finishes.
 */
export async function verifyMailAttachments(
    query: MiraQuery,
    context: MiraContext,
    snapshots: MiraMailAttachment[]
): Promise<void> {
    const current = await captureMailAttachments(
        query,
        { client: context.client, owner: context.owner, actor: context.actor },
        snapshots.map((file) => file.id),
        null
    );
    if (
        !current.every((file, index) => {
            const snapshot = snapshots[index]!;
            return (
                file.id === snapshot.id &&
                file.name === snapshot.name &&
                file.mediaType === snapshot.mediaType &&
                file.bytes === snapshot.bytes &&
                file.sha256 === snapshot.sha256
            );
        })
    )
        throw new MiraFailure(
            "CONFLICT",
            "An email attachment changed. Save and review the draft again."
        );
}

/**
 * Build a bounded provider request from verified local files, without external download URLs.
 * @param context - Provisioned sender owner and product pool.
 * @param directory - Shared private file store, required only for attachments.
 * @param content - Approved text and server-owned file snapshots.
 * @returns Serialized provider body; local failures happen before a send attempt is claimed.
 */
export async function miraMailRequestBody(
    context: MiraContext,
    directory: string | undefined,
    content: MiraMailContent
): Promise<string> {
    const { attachments: snapshots = [], reply, subject, ...message } = content;
    const attachments: { filename: string; content_type: string; content: string }[] = [];
    for (const snapshot of snapshots) {
        const file = await readMiraFile(context, directory, snapshot.id);
        if (
            new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex") !==
                snapshot.sha256 ||
            file.bytes.length !== snapshot.bytes
        )
            throw new MiraFailure(
                "CONFLICT",
                "An email attachment changed. Save and review the draft again."
            );
        attachments.push({
            filename: snapshot.name,
            content_type: snapshot.mediaType,
            content: Buffer.from(file.bytes).toString("base64"),
        });
    }
    const body = JSON.stringify({
        ...message,
        ...(reply ? { reply_all: false } : { subject }),
        ...(attachments.length > 0 ? { attachments } : {}),
        track_opens: false,
    });
    if (Buffer.byteLength(body) > 6_000_000)
        throw new MiraFailure(
            "BAD_REQUEST",
            "This email exceeds the provider's 6 MB request limit."
        );
    return body;
}
