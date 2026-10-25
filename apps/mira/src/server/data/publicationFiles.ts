import {
    miraPublicationFileSchema,
    type MiraPublicationFile,
    type MiraPublicationInput,
} from "@homelab/contracts/miraPublication";
import * as v from "valibot";

import { MiraFailure, type MiraContext, type MiraQuery } from "./context";
import { readMiraFile } from "./files";

const textTypes: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json",
    txt: "text/plain; charset=utf-8",
    md: "text/markdown; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    svg: "image/svg+xml",
};
const binaryTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    pdf: "application/pdf",
};

function publicationType(path: string, source: string): string {
    const extension = path.split(".").at(-1)!.toLowerCase();
    const type = source.startsWith("text/plain")
        ? textTypes[extension]
        : binaryTypes[extension];
    if (!type || (!source.startsWith("text/plain") && type !== source))
        throw new MiraFailure(
            "BAD_REQUEST",
            "Use a supported web, text, image or PDF extension matching the selected file."
        );
    return type;
}

/**
 * Capture exactly the owned files selected for a local publication draft.
 * @param query - Draft transaction; file locks serialize deletion with snapshot capture.
 * @param context - Human or fenced assistant owner.
 * @param selections - Unique file IDs and site-relative paths; reserved dot-directories are excluded by the contract.
 * @param conversationId - Model's conversation, limiting files to explicitly shared attachments.
 * @returns Bounded file snapshots, including the actual outgoing MIME types and hashes.
 */
export async function capturePublicationFiles(
    query: MiraQuery,
    context: MiraContext,
    selections: MiraPublicationInput["files"],
    conversationId: string | null
): Promise<MiraPublicationFile[]> {
    if (
        new Set(selections.map((file) => file.id)).size !== selections.length ||
        new Set(selections.map((file) => file.path)).size !== selections.length
    )
        throw new MiraFailure(
            "BAD_REQUEST",
            "Choose different files and a unique path for each file."
        );
    const files: MiraPublicationFile[] = [];
    for (const selection of selections) {
        const [file] = await query<
            {
                id: string;
                name: string;
                mediaType: string;
                bytes: number;
                sha256: string;
            }[]
        >`SELECT id,name,media_type AS "mediaType",bytes,sha256 FROM mira_attachments WHERE id=${selection.id} AND owner=${context.owner} AND deleted_at IS NULL AND ready_at IS NOT NULL FOR SHARE`;
        if (!file)
            throw new MiraFailure(
                "NOT_FOUND",
                "A selected publication file is no longer available."
            );
        if (context.run) {
            const linked = await query<
                { id: string }[]
            >`SELECT id FROM mira_messages WHERE conversation_id=${conversationId} AND attachment_ids @> ${JSON.stringify([file.id])}::text::jsonb LIMIT 1`;
            if (!linked[0])
                throw new MiraFailure(
                    "FORBIDDEN",
                    "Only files shared in this conversation can be proposed for publication."
                );
        }
        files.push({
            ...file,
            path: selection.path,
            mediaType: publicationType(selection.path, file.mediaType),
        });
    }
    if (files.reduce((total, file) => total + file.bytes, 0) > 25 * 1024 * 1024)
        throw new MiraFailure(
            "BAD_REQUEST",
            "Publication files must total no more than 25 MiB."
        );
    return files;
}

/**
 * Verify approved files still exist and contain exactly their reviewed bytes.
 * @param context - Verified owner and optional admission transaction.
 * @param directory - Private local file volume; no external download URLs are accepted.
 * @param files - Immutable approved snapshots.
 * @returns In-memory verified bytes for a bounded publication attempt.
 */
export async function readPublicationFiles(
    context: MiraContext,
    directory: string | undefined,
    files: MiraPublicationFile[]
): Promise<Uint8Array[]> {
    await verifyPublicationFiles(context.transaction ?? context.client, context, files);
    const bytes: Uint8Array[] = [];
    for (const snapshot of files) {
        const file = await readMiraFile(context, directory, snapshot.id);
        if (
            new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex") !==
            snapshot.sha256
        )
            throw new MiraFailure(
                "CONFLICT",
                "A publication file changed. Save and review the draft again."
            );
        bytes.push(file.bytes);
    }
    return bytes;
}

/**
 * Recheck approved file metadata under the publication admission transaction.
 * @param query - Transaction holding owner controls before file locks.
 * @param context - Verified publication owner.
 * @param files - Exact immutable approved snapshots.
 * @returns Completion only while all selected files remain available and unchanged.
 */
export async function verifyPublicationFiles(
    query: MiraQuery,
    context: MiraContext,
    files: MiraPublicationFile[]
): Promise<void> {
    const current = await capturePublicationFiles(
        query,
        { client: context.client, owner: context.owner, actor: context.actor },
        files.map(({ id, path }) => ({ id, path })),
        null
    );
    if (
        JSON.stringify(v.parse(v.array(miraPublicationFileSchema), current)) !==
        JSON.stringify(v.parse(v.array(miraPublicationFileSchema), files))
    )
        throw new MiraFailure(
            "CONFLICT",
            "A publication file changed. Save and review the draft again."
        );
}
