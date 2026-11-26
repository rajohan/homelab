import { miraBrowserHumanOperationSchema } from "@homelab/contracts/miraBrowser";
import type { SQL } from "bun";
import * as v from "valibot";

import { browserCommandResult } from "../browsing/command";
import {
    browserGestureResult,
    type browserWorkerFrame,
    browserWorkerTabs,
} from "../browsing/wire";
import { readBrowserAccess } from "./browserAccess";
import { type BrowserCommandClaim, browserHostContext } from "./browserCommands";
import { saveBrowserPreview } from "./browserConsole";
import { requireBrowserDownload } from "./browserDownloadAccess";
import { requireBrowserUpload } from "./browserUploads";
import { MiraFailure } from "./context";

/** Publish one clicked target only to the still-active human control generation.
 * @param client - Privileged local browser host database.
 * @param claim - Process and run lease that produced the gesture.
 * @param epoch - Operator generation from the authenticated live input connection.
 * @param event - A clicked page control or a document change invalidating that target.
 * @returns Completion after rechecking the fixed website and active grant.
 */
export async function publishBrowserFileGesture(
    client: SQL,
    claim: BrowserCommandClaim,
    epoch: string,
    event: NonNullable<ReturnType<typeof browserGestureResult>>
) {
    await client.begin(async (query) => {
        const { context, accessId } = await browserHostContext(client, query, claim);
        const access = await readBrowserAccess(query, context.owner, accessId);
        if (
            !access?.available ||
            access.state !== "active" ||
            access.controller !== "human" ||
            access.mode !== "control" ||
            access.policy?.origins.length !== 1
        )
            return;
        if ("cleared" in event) {
            await query`UPDATE mira_browser_consoles SET frame=NULL,frame_at=NULL WHERE access_id=${accessId}
                AND controller='human' AND epoch=${epoch} AND state='idle' AND frame->'fileRequest'->>'id'=${event.cleared}`;
            return;
        }
        browserGestureResult(event, {
            origins: access.policy.origins,
            uploads: true,
            downloads: true,
        });
        await query`UPDATE mira_browser_consoles SET frame=${JSON.stringify(event)}::text::jsonb,frame_at=clock_timestamp()
            WHERE access_id=${accessId} AND controller='human' AND epoch=${epoch} AND state='idle'`;
    });
}

/**
 * Claim one operator operation for the already running, exclusively held browser.
 * @param client - Private host database.
 * @param claim - Durable process/controller identity, never supplied by a human endpoint.
 * @returns One non-replayable command, or null while the operator has no queued work.
 */
export async function claimBrowserHumanCommand(client: SQL, claim: BrowserCommandClaim) {
    return client.begin(async (query) => {
        const { context, accessId } = await browserHostContext(client, query, claim);
        const access = await readBrowserAccess(query, context.owner, accessId);
        const [row] = await query<
            { commandId: string; epoch: string; payload: unknown; validForMs: number }[]
        >`SELECT command_id AS "commandId",epoch,payload,greatest(0,floor(extract(epoch FROM (expires_at-clock_timestamp()))*1000))::int AS "validForMs" FROM mira_browser_consoles WHERE access_id=${accessId} AND controller='human' AND state='queued' AND expires_at>clock_timestamp() FOR UPDATE`;
        if (!row) return null;
        if (
            !access?.available ||
            access.state !== "active" ||
            access.controller !== "human" ||
            row.validForMs < 1
        )
            throw new MiraFailure("FORBIDDEN", "Browser operator authority expired.");
        const operation = v.parse(miraBrowserHumanOperationSchema, row.payload);
        if (operation.method !== "observe" && access.mode !== "control")
            throw new MiraFailure("FORBIDDEN", "Browser access is view-only.");
        if (operation.method === "download")
            await requireBrowserDownload(query, context.owner, accessId, operation);
        if (operation.method === "upload")
            await requireBrowserUpload(query, context.owner, accessId, operation);
        await query`UPDATE mira_browser_consoles SET state='claimed',payload=NULL WHERE access_id=${accessId}`;
        return {
            id: row.commandId,
            epoch: row.epoch,
            operation,
            validForMs: Math.min(25_000, row.validForMs),
        };
    });
}
/**
 * Settle operator delivery without disclosing its result to the model's tool queue.
 * @param client - Private host connection.
 * @param claim - Original durable controller identity.
 * @param command - Exact once-claimed command and controller generation.
 * @param result - Untrusted native result, validated against the original grant.
 * @returns Whether delivery settled; failure requires session retirement, never input replay.
 */
export async function finishBrowserHumanCommand(
    client: SQL,
    claim: BrowserCommandClaim,
    command: {
        id: string;
        epoch: string;
        operation: v.InferOutput<typeof miraBrowserHumanOperationSchema>;
    },
    result: unknown
): Promise<boolean> {
    if (command.operation.method === "download")
        throw new Error(
            "Downloads must settle atomically with the conversation attachment."
        );
    const method = command.operation.method;
    return client.begin(async (query) => {
        const { context, accessId } = await browserHostContext(client, query, claim);
        const access = await readBrowserAccess(query, context.owner, accessId);
        if (
            !access?.available ||
            access.state !== "active" ||
            access.controller !== "human" ||
            !access.policy
        )
            return false;
        let frame: ReturnType<typeof browserWorkerFrame> | undefined;
        if (method === "tabs") {
            if (result !== null) browserWorkerTabs(result, access.policy.origins);
        } else {
            const parsed = browserCommandResult(
                method === "upload" ? "act" : method,
                result,
                access.policy.origins
            );
            if ("content" in parsed) frame = parsed;
        }
        const updated = await query<
            { accessId: string }[]
        >`UPDATE mira_browser_consoles SET state='idle',method=NULL,expires_at=NULL,payload=NULL
            WHERE access_id=${accessId} AND controller='human' AND epoch=${command.epoch} AND command_id=${command.id} AND state='claimed' AND expires_at>clock_timestamp()
            RETURNING access_id AS "accessId"`;
        if (updated.length !== 1) return false;
        if (frame) await saveBrowserPreview(query, accessId, frame);
        return true;
    });
}
