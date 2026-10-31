import { miraBrowserHumanOperationSchema } from "@homelab/contracts/miraBrowser";
import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import type { BrowserDownloadFile } from "../browsing/downloadTransfer";
import { browserHostContext, type BrowserCommandClaim } from "./browserCommands";
import { requireBrowserDownload } from "./browserDownloadAccess";
import { auditMira, MiraFailure, type MiraContext } from "./context";
import { saveMiraFile } from "./files";

function requireSignal(signal: AbortSignal): void {
    if (signal.aborted)
        throw new MiraFailure(
            "CONFLICT",
            "The browser download was cancelled before it could be saved."
        );
}

type Operation = v.InferOutput<typeof miraBrowserHumanOperationSchema>;

/**
 * Import a completed download and settle its operator command in the same readiness transaction.
 * @param client - Trusted host database connection.
 * @param claim - Exact durable process/controller identity; never browser parameters.
 * @param command - Once-claimed human command and generation.
 * @param directory - Private product file store, mounted only into the trusted host.
 * @param file - Bounded, digest-verified bytes from the private worker transport.
 * @param signal - Command/run cancellation, checked at reservation and readiness boundaries.
 * @returns The owned attachment, linked to this run's response before it becomes ready.
 */
export async function saveBrowserDownload(
    client: SQL,
    claim: BrowserCommandClaim,
    command: { id: string; epoch: string; operation: Operation },
    directory: string | undefined,
    file: BrowserDownloadFile,
    signal: AbortSignal
) {
    requireSignal(signal);
    const operation = v.parse(miraBrowserHumanOperationSchema, command.operation);
    if (
        operation.method !== "download" ||
        new Bun.CryptoHasher("sha256").update(file.bytes).digest("hex") !== file.sha256
    )
        throw new Error("The confirmed browser download is unavailable.");
    const bind = async (query: TransactionSQL) => {
        requireSignal(signal);
        const binding = await browserHostContext(client, query, claim);
        await requireBrowserDownload(
            query,
            binding.context.owner,
            binding.accessId,
            operation
        );
        const [active] = await query<{ id: string }[]>`
            SELECT access_id AS id FROM mira_browser_consoles WHERE access_id=${binding.accessId}
            AND controller='human' AND epoch=${command.epoch} AND command_id=${command.id}
            AND method='download' AND state='claimed' AND expires_at>clock_timestamp() FOR UPDATE`;
        if (!active)
            throw new MiraFailure(
                "CONFLICT",
                "The browser download command expired or changed."
            );
        return binding;
    };
    const initial = await client.begin(bind);
    const context: MiraContext = {
        client,
        owner: initial.context.owner,
        actor: initial.context.actor,
        run: initial.context.run!,
    };
    requireSignal(signal);
    return saveMiraFile(
        context,
        directory,
        { id: command.id, name: operation.name, bytes: file.bytes },
        async (query) => {
            const current = await bind(query);
            if (
                current.context.owner !== context.owner ||
                current.context.run?.id !== context.run!.id
            )
                throw new Error("The browser download owner changed.");
            await auditMira(query, context, "file.browser_downloaded", command.id);
            const linked = await query<{ id: string }[]>`
            UPDATE mira_messages m SET attachment_ids=CASE WHEN attachment_ids @> ${JSON.stringify([command.id])}::text::jsonb
                THEN attachment_ids ELSE attachment_ids||${JSON.stringify([command.id])}::text::jsonb END
            FROM mira_runs r JOIN mira_conversations c ON c.id=r.conversation_id
            WHERE r.id=${context.run!.id} AND r.owner=${context.owner} AND c.owner=${context.owner} AND c.deleted_at IS NULL
            AND m.id=r.assistant_message_id AND m.conversation_id=c.id
            AND (jsonb_array_length(m.attachment_ids)<8 OR m.attachment_ids @> ${JSON.stringify([command.id])}::text::jsonb)
            RETURNING m.id`;
            if (linked.length !== 1)
                throw new MiraFailure(
                    "CONFLICT",
                    "This response is unavailable or already contains eight files."
                );
            requireSignal(signal);
            const settled = await query<{ id: string }[]>`
            UPDATE mira_browser_consoles SET state='idle',method=NULL,expires_at=NULL,payload=NULL
            WHERE access_id=${current.accessId} AND controller='human' AND epoch=${command.epoch}
            AND command_id=${command.id} AND state='claimed' AND method='download' AND expires_at>clock_timestamp()
            RETURNING access_id AS id`;
            if (settled.length !== 1)
                throw new MiraFailure(
                    "CONFLICT",
                    "The browser download expired before it could be saved."
                );
        }
    );
}
