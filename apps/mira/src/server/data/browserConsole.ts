import {
    miraBrowserConsoleSchema,
    miraBrowserHumanCommandSchema,
    miraBrowserHumanOperationSchema,
    miraBrowserTransferSchema,
    type MiraBrowserConsole,
} from "@homelab/contracts/miraBrowser";
import type { SQL, TransactionSQL } from "bun";
import * as v from "valibot";

import { browserUrl } from "../browsing/policy";
import { browserWorkerFrame } from "../browsing/wire";
import { lockBrowserOwner, readBrowserAccess } from "./browserAccess";
import { retireBrowserCommands } from "./browserRetirement";
import { requireBrowserUpload } from "./browserUploads";
import { auditMira, MiraFailure, type MiraContext } from "./context";

type Frame = ReturnType<typeof browserWorkerFrame>;
interface ConsoleRow {
    epoch: string;
    controller: "mira" | "human";
    state: "idle" | "queued" | "claimed";
    frame: Frame | null;
    frameAt: Date | null;
    fresh: boolean;
}
const unavailable = () =>
    new MiraFailure(
        "PRECONDITION_FAILED",
        "Browser control is unavailable or changed. Refresh before continuing."
    );
async function human(query: TransactionSQL, context: MiraContext, id: string) {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure(
            "FORBIDDEN",
            "Only the signed-in operator can control this browser."
        );
    await lockBrowserOwner(query, context.owner);
    const access = await readBrowserAccess(query, context.owner, id);
    if (!access?.available || access.state !== "active" || !access.policy)
        throw unavailable();
    const [console] = await query<
        ConsoleRow[]
    >`SELECT epoch,controller,state,frame,frame_at AS "frameAt",frame_at>clock_timestamp()-(CASE WHEN controller='human' THEN interval '60 seconds' ELSE interval '10 seconds' END) AS fresh FROM mira_browser_consoles WHERE access_id=${id}`;
    if (!console) throw unavailable();
    return { access, console };
}
async function modelBusy(query: TransactionSQL, id: string) {
    const [row] = await query<
        { busy: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM mira_browser_commands c JOIN mira_tool_receipts t ON t.id=c.id WHERE c.access_id=${id} AND (c.state IN ('queued','claimed','completed') OR (c.state='consumed' AND t.state='running'))) AS busy`;
    return row!.busy;
}
/**
 * Save the last completed observation without taking another native snapshot or changing refs.
 * @param query - Host transaction holding the owning account lock.
 * @param accessId - Current owned grant.
 * @param frame - Already validated bounded worker observation.
 * @returns Completion after replacing the transient preview; page outlines are not retained.
 */
export async function saveBrowserPreview(
    query: TransactionSQL,
    accessId: string,
    frame: Frame
) {
    await query`UPDATE mira_browser_consoles SET frame=${JSON.stringify({ ...frame, outline: "", complete: false })}::text::jsonb,frame_at=clock_timestamp() WHERE access_id=${accessId}`;
}
/**
 * Read the latest bounded preview without issuing a browser operation or exposing private claims.
 * @param context - Signed-in owner, never an automation or model context.
 * @param input - Exact owned grant.
 * @returns Controller generation, busy state and recent image; no browser HTML is rendered.
 */
export async function readMiraBrowserConsole(
    context: MiraContext,
    input: unknown
): Promise<MiraBrowserConsole> {
    const { id } = v.parse(miraBrowserConsoleSchema, input);
    return context.client.begin(async (query) => {
        const { access, console } = await human(query, context, id);
        const frame =
            console.frame &&
            console.frameAt &&
            Date.now() - console.frameAt.getTime() < 60_000
                ? browserWorkerFrame(console.frame, access.policy!.origins)
                : null;
        return {
            epoch: console.epoch,
            controller: console.controller,
            busy: console.state !== "idle" || (await modelBusy(query, id)),
            preview: frame
                ? {
                      observationId: frame.observationId,
                      url: frame.url,
                      title: frame.title,
                      refs:
                          console.controller === "human" && console.fresh
                              ? frame.refs
                              : [],
                      width: frame.width,
                      height: frame.height,
                      image: frame.content.content[0]!.data,
                      observedAt: console.frameAt!.toISOString(),
                  }
                : null,
        };
    });
}
/**
 * Transfer an idle browser atomically; an in-flight command must settle before changing controllers.
 * @param context - Freshly verified operator.
 * @param input - Expected generation and desired controller, without extending the original grant.
 * @returns Completion; closing the page never silently resumes Mira.
 */
export async function transferMiraBrowserControl(
    context: MiraContext,
    input: unknown
): Promise<void> {
    const request = v.parse(miraBrowserTransferSchema, input);
    await context.client.begin(async (query) => {
        const { console } = await human(query, context, request.id);
        if (console.epoch !== request.epoch || console.state !== "idle")
            throw unavailable();
        if (await modelBusy(query, request.id))
            throw new MiraFailure(
                "CONFLICT",
                "Mira is finishing a browser action. Try again when it finishes."
            );
        if (console.controller === request.controller) return;
        await query`UPDATE mira_browser_consoles SET controller=${request.controller},epoch=${crypto.randomUUID()},frame=NULL,frame_at=NULL WHERE access_id=${request.id}`;
        await auditMira(
            query,
            context,
            request.controller === "human" ? "browser.taken_over" : "browser.returned",
            request.id
        );
    });
}
/**
 * Validate a single-use input against the latest console observation as well as native enforcement.
 * @param query - Account-locked transaction.
 * @param id - Current grant identity.
 * @param operation - Already parsed input operation.
 * @returns Completion only for a fresh observed ref permitting the requested action.
 */
export async function requireBrowserObservation(
    query: TransactionSQL,
    id: string,
    operation: v.InferOutput<typeof miraBrowserHumanOperationSchema>
) {
    if (operation.method !== "act" && operation.method !== "upload") return;
    const [row] = await query<
        { frame: Frame }[]
    >`SELECT frame FROM mira_browser_consoles WHERE access_id=${id} AND frame IS NOT NULL AND frame_at>clock_timestamp()-(CASE WHEN controller='human' THEN interval '60 seconds' ELSE interval '10 seconds' END)`;
    if (
        !row ||
        row.frame.observationId !== operation.input.observationId ||
        (operation.method === "upload" &&
            new URL(row.frame.url).origin !== operation.origin) ||
        !row.frame.refs.some(
            (item) =>
                item.ref === operation.input.ref &&
                item.actions.includes(
                    operation.method === "upload" ? "upload" : operation.input.action
                )
        )
    )
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Refresh the browser view and choose a current page element."
        );
}
/**
 * Queue an operator command without writing its content to Chat, tool receipts or audit logs.
 * @param context - Freshly verified owner.
 * @param input - Unique request, current controller generation and bounded operation.
 * @returns Completion after admission; requests are never automatically replayed.
 */
export async function enqueueMiraBrowserHumanCommand(
    context: MiraContext,
    input: unknown
): Promise<void> {
    const request = v.parse(miraBrowserHumanCommandSchema, input);
    const operation = v.parse(miraBrowserHumanOperationSchema, request.operation);
    await context.client.begin(async (query) => {
        const { access, console } = await human(query, context, request.id);
        if (
            console.controller !== "human" ||
            console.epoch !== request.epoch ||
            console.state !== "idle" ||
            (await modelBusy(query, request.id))
        )
            throw unavailable();
        if (
            (operation.method === "act" || operation.method === "upload") &&
            access.mode !== "control"
        )
            throw unavailable();
        if (operation.method === "upload")
            await requireBrowserUpload(query, context.owner, request.id, operation);
        if (operation.method === "navigate") {
            try {
                browserUrl(operation.url, access.policy!.origins);
            } catch {
                throw new MiraFailure(
                    "BAD_REQUEST",
                    "Choose a URL within the websites already approved for this run."
                );
            }
        }
        await requireBrowserObservation(query, request.id, operation);
        const updated = await query<
            { accessId: string }[]
        >`UPDATE mira_browser_consoles SET command_id=${request.commandId},state='queued',method=${operation.method},payload=${JSON.stringify(operation)}::text::jsonb,
            expires_at=clock_timestamp()+interval '25 seconds',frame=NULL,frame_at=NULL,attempts=attempts||${JSON.stringify([request.commandId])}::text::jsonb
            WHERE access_id=${request.id} AND jsonb_array_length(attempts)<128 AND NOT attempts @> ${JSON.stringify([request.commandId])}::text::jsonb RETURNING access_id AS "accessId"`;
        if (updated.length !== 1) throw unavailable();
        await auditMira(
            query,
            context,
            "browser.operator_" + operation.method,
            request.id
        );
    });
}

/**
 * Erase expired previews and revoke uncertain operator commands independently of the browser host.
 * @param client - Product database; grants and native processes retain their existing capacity bounds.
 * @returns Completion without exposing page or typed content.
 */
export async function cleanupBrowserConsoles(client: SQL): Promise<void> {
    await client`UPDATE mira_browser_consoles SET frame=NULL,frame_at=NULL WHERE frame_at<clock_timestamp()-interval '60 seconds'`;
    const rows = await client<
        { accessId: string; owner: string }[]
    >`SELECT c.access_id AS "accessId",g.owner FROM mira_browser_consoles c JOIN mira_browser_access g ON g.id=c.access_id WHERE c.state<>'idle' OR c.frame IS NOT NULL OR g.state IN ('pending','active') ORDER BY g.expires_at,g.id LIMIT 32`;
    for (const row of rows)
        await client.begin(async (query) => {
            await lockBrowserOwner(query, row.owner);
            const access = await readBrowserAccess(query, row.owner, row.accessId);
            const [expired] = await query<
                { id: string }[]
            >`SELECT access_id AS id FROM mira_browser_consoles WHERE access_id=${row.accessId} AND state<>'idle' AND expires_at<=clock_timestamp()`;
            if (!access?.available || expired)
                await retireBrowserCommands(query, row.owner, row.accessId);
        });
}
