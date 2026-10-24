import { constants } from "node:fs";
import { mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import type { MiraAttachment } from "@homelab/contracts/mira";
import { idSchema } from "@homelab/contracts/operations";
import type { SQL } from "bun";
import * as v from "valibot";

import { auditMira, MiraFailure, type MiraContext } from "./context";

export const miraFileLimit = 25 * 1024 * 1024;

function invalidCharacters(value: string, filename: boolean): boolean {
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (code < 32 && (filename || ![9, 10, 13].includes(code))) return true;
        if (filename && (code === 127 || character === "/" || character === "\\"))
            return true;
    }
    return false;
}

/**
 * Resolve the explicitly provisioned file store; user filenames never become paths.
 * @param directory - Absolute private volume path supplied by deployment.
 * @returns Canonical directory, or a public configuration failure.
 */
export async function miraFileDirectory(directory: string | undefined): Promise<string> {
    if (!directory || !path.isAbsolute(directory))
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Mira file storage is not configured."
        );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return realpath(directory);
}

/**
 * Classify supported uploads from bytes, never trusting the browser MIME declaration.
 * @param bytes - Bounded, nonempty upload.
 * @returns Passive supported content type.
 */
export function miraFileType(bytes: Uint8Array): string {
    const head = Buffer.from(bytes.subarray(0, 16));
    if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return "image/png";
    if (head[0] === 255 && head[1] === 216 && head[2] === 255) return "image/jpeg";
    if (
        head.toString("ascii", 0, 4) === "RIFF" &&
        head.toString("ascii", 8, 12) === "WEBP"
    )
        return "image/webp";
    if (head.toString("ascii", 0, 5) === "%PDF-") return "application/pdf";
    try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (invalidCharacters(content, false)) throw new Error("Binary content");
        return "text/plain; charset=utf-8";
    } catch {
        throw new MiraFailure(
            "BAD_REQUEST",
            "Use a PNG, JPEG, WebP, PDF or UTF-8 text file, up to 25 MiB."
        );
    }
}

/**
 * Store one owner-scoped upload with bounded quotas and retry-safe client identity.
 * @param context - Verified human identity.
 * @param directory - Private persistent file volume.
 * @param input - Validated identity, display name and bounded upload bytes.
 * @returns Public attachment metadata; retrying identical bytes returns the same record.
 */
export async function saveMiraFile(
    context: MiraContext,
    directory: string | undefined,
    input: { id: string; name: string; bytes: Uint8Array }
): Promise<MiraAttachment> {
    v.parse(idSchema, input.id);
    if (
        !input.bytes.byteLength ||
        input.bytes.byteLength > miraFileLimit ||
        !input.name.trim() ||
        input.name.length > 200 ||
        invalidCharacters(input.name, true)
    )
        throw new MiraFailure(
            "BAD_REQUEST",
            "Use a filename without paths and a file between 1 byte and 25 MiB."
        );
    const root = await miraFileDirectory(directory);
    const mediaType = miraFileType(input.bytes);
    const sha256 = new Bun.CryptoHasher("sha256").update(input.bytes).digest("hex");
    const filePath = path.join(root, input.id);

    // Commit the reservation before touching disk. A crash always leaves a durable
    // pending receipt, and a lost commit response cannot delete an accepted file.
    await context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended('homelab:mira:files', 0))`;
        const [existing] = await query<
            { name: string; sha256: string }[]
        >`SELECT name, sha256 FROM mira_attachments WHERE id = ${input.id} AND owner = ${context.owner} AND deleted_at IS NULL`;
        if (existing) {
            if (existing.sha256 !== sha256 || existing.name !== input.name)
                throw new MiraFailure(
                    "CONFLICT",
                    "This upload identity was already used for another file."
                );
            return;
        }
        const [usage] = await query<
            {
                total: number;
                owned: number;
                recent: number;
                count: number;
                ownedCount: number;
            }[]
        >`SELECT coalesce(sum(bytes) FILTER (WHERE purged_at IS NULL),0)::float8 AS total, coalesce(sum(bytes) FILTER (WHERE owner = ${context.owner} AND purged_at IS NULL),0)::float8 AS owned, count(*) FILTER (WHERE owner = ${context.owner} AND created_at > now() - interval '1 minute')::int AS recent, count(*) FILTER (WHERE purged_at IS NULL)::int AS count, count(*) FILTER (WHERE owner = ${context.owner} AND purged_at IS NULL)::int AS "ownedCount" FROM mira_attachments`;
        if (
            !usage ||
            usage.total + input.bytes.length > 50 * 1024 ** 3 ||
            usage.owned + input.bytes.length > 10 * 1024 ** 3 ||
            usage.recent >= 20 ||
            usage.count >= 25_000 ||
            usage.ownedCount >= 5000
        )
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "File storage or upload rate limit reached. Remove unused files or try again later."
            );
        await query`INSERT INTO mira_attachments (id, owner, name, media_type, bytes, sha256) VALUES (${input.id}, ${context.owner}, ${input.name}, ${mediaType}, ${input.bytes.length}, ${sha256})`;
    });
    return context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended('homelab:mira:files', 0))`;
        const [pending] = await query<
            { readyAt: Date | null; sha256: string }[]
        >`SELECT ready_at AS "readyAt", sha256 FROM mira_attachments WHERE id = ${input.id} AND owner = ${context.owner} AND deleted_at IS NULL FOR UPDATE`;
        if (!pending || pending.sha256 !== sha256)
            throw new MiraFailure("CONFLICT", "This upload is no longer available.");
        if (!pending.readyAt) {
            // Only an unexposed pending upload may be replaced after a process interruption.
            await removeFile(filePath);
            const handle = await open(
                filePath,
                constants.O_WRONLY |
                    constants.O_CREAT |
                    constants.O_EXCL |
                    constants.O_NOFOLLOW,
                0o600
            );

            try {
                await handle.writeFile(input.bytes);
                await handle.sync();
            } finally {
                await handle.close();
            }
            await query`UPDATE mira_attachments SET ready_at = now() WHERE id = ${input.id}`;
            await auditMira(query, context, "file.uploaded", input.id);
        }
        const [record] = await query<
            MiraAttachment[]
        >`SELECT id, name, media_type AS "mediaType", bytes, created_at::text AS "createdAt" FROM mira_attachments WHERE id = ${input.id}`;
        return record!;
    });
}

/**
 * Read an owned live attachment without following symlinks or accepting arbitrary paths.
 * @param context - Verified human or run owner.
 * @param directory - Private file volume whose contents are selected through owned message IDs.
 * @param id - Product attachment identity.
 * @returns Metadata and verified bytes, bounded by the stored size and digest.
 */
export async function readMiraFile(
    context: MiraContext,
    directory: string | undefined,
    id: string
): Promise<{ metadata: MiraAttachment; bytes: Uint8Array }> {
    v.parse(idSchema, id);
    const [metadata] = await context.client<
        (MiraAttachment & { sha256: string })[]
    >`SELECT id, name, media_type AS "mediaType", bytes, created_at::text AS "createdAt", sha256 FROM mira_attachments WHERE id = ${id} AND owner = ${context.owner} AND deleted_at IS NULL AND ready_at IS NOT NULL`;
    if (!metadata) throw new MiraFailure("NOT_FOUND", "File not found.");
    const root = await miraFileDirectory(directory);
    const handle = await open(
        path.join(root, id),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== metadata.bytes || stat.size > miraFileLimit)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "The stored file could not be verified."
            );
        const buffer = Buffer.alloc(metadata.bytes + 1);
        let length = 0;
        while (length < buffer.length) {
            const { bytesRead } = await handle.read(
                buffer,
                length,
                buffer.length - length,
                length
            );
            if (bytesRead === 0) break;
            length += bytesRead;
        }
        if (length !== metadata.bytes)
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "The stored file could not be verified."
            );
        const bytes = buffer.subarray(0, length);
        if (
            new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== metadata.sha256
        )
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "The stored file could not be verified."
            );
        return {
            metadata: {
                id: metadata.id,
                name: metadata.name,
                mediaType: metadata.mediaType,
                bytes: metadata.bytes,
                createdAt: metadata.createdAt,
            },
            bytes,
        };
    } finally {
        await handle.close();
    }
}

/**
 * List uploaded files without exposing disk paths or content digests.
 * @param context - Verified owner.
 * @param before - Optional pagination identity.
 * @returns One bounded page, including files not yet attached to a message.
 */
export async function listMiraFiles(context: MiraContext, before?: string) {
    const rows = await context.client<
        MiraAttachment[]
    >`SELECT id, name, media_type AS "mediaType", bytes, created_at::text AS "createdAt" FROM mira_attachments WHERE owner = ${context.owner} AND deleted_at IS NULL AND ready_at IS NOT NULL AND (${before ?? null}::uuid IS NULL OR (created_at,id) < (SELECT created_at,id FROM mira_attachments WHERE id = ${before ?? null}::uuid AND owner = ${context.owner})) ORDER BY created_at DESC,id DESC LIMIT 30`;
    return { rows, nextCursor: rows.length === 30 ? rows.at(-1)!.id : null };
}

/**
 * Resolve only owned attachment metadata for message previews, without reading file contents.
 * @param context - Authenticated operator.
 * @param ids - Validated bounded list of message attachment identities.
 * @returns Live owned files; deleted and foreign records are indistinguishable.
 */
export async function miraFileMetadata(
    context: MiraContext,
    ids: string[]
): Promise<MiraAttachment[]> {
    return context.client<
        MiraAttachment[]
    >`SELECT id, name, media_type AS "mediaType", bytes, created_at::text AS "createdAt" FROM mira_attachments WHERE owner = ${context.owner} AND deleted_at IS NULL AND ready_at IS NOT NULL AND id::text IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb))`;
}

/**
 * Remove an owned attachment while preserving a content-free audit receipt.
 * @param context - Verified human owner.
 * @param directory - Private writable file store.
 * @param id - Attachment identity; referenced messages display an unavailable attachment.
 * @returns Completion after access is revoked and physical deletion attempted.
 */
export async function deleteMiraFile(
    context: MiraContext,
    directory: string | undefined,
    id: string
): Promise<void> {
    v.parse(idSchema, id);
    const root = await miraFileDirectory(directory);
    await context.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended('homelab:mira:files', 0))`;
        const rows = await query<
            { id: string }[]
        >`UPDATE mira_attachments SET deleted_at = coalesce(deleted_at,now()), name = 'Deleted file' WHERE id = ${id} AND owner = ${context.owner} RETURNING id`;
        if (rows.length === 0) throw new MiraFailure("NOT_FOUND", "File not found.");
        await auditMira(query, context, "file.deleted", id);
    });
    await removeFile(path.join(root, id));
    await context.client`UPDATE mira_attachments SET purged_at = now(), sha256 = '' WHERE id = ${id} AND owner = ${context.owner} AND deleted_at IS NOT NULL`;
}

async function removeFile(file: string): Promise<void> {
    try {
        await unlink(file);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
            throw error;
    }
}

/**
 * Reconcile interrupted uploads and durable deletion intents without scanning unrelated paths.
 * @param client - Executor database connection.
 * @param directory - Explicit shared writable file volume, absent before provisioning.
 * @returns Number of physical files reconciled in this bounded pass.
 */
export async function cleanupMiraFiles(
    client: SQL,
    directory: string | undefined
): Promise<number> {
    if (!directory) return 0;
    const root = await miraFileDirectory(directory);
    return client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended('homelab:mira:files', 0))`;
        const rows = await query<
            { id: string; owner: string }[]
        >`SELECT id, owner FROM mira_attachments WHERE purged_at IS NULL AND (deleted_at IS NOT NULL OR (ready_at IS NULL AND created_at < now() - interval '1 day')) ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED`;
        for (const row of rows) {
            await removeFile(path.join(root, v.parse(idSchema, row.id)));
            await query`UPDATE mira_attachments SET deleted_at = coalesce(deleted_at,now()), purged_at = now(), sha256 = '', name = 'Deleted file' WHERE id = ${row.id}`;
            await auditMira(
                query,
                { owner: row.owner, actor: "mira:cleanup" },
                "file.purged",
                row.id
            );
        }
        return rows.length;
    });
}
