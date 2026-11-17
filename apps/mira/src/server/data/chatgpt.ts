import {
    chatgptStatusMessage,
    miraChatgptStatusSchema,
} from "@homelab/contracts/miraChatgpt";
import * as v from "valibot";

import { auditMira, type MiraContext, MiraFailure } from "./context";

export interface ChatgptLogin {
    requestId: string;
    owner: string;
    state: "requested" | "starting" | "waiting" | "completed" | "failed" | "cancelled";
    verificationUrl: string | null;
    userCode: string | null;
    message: string | null;
    expiresAt: string;
}

/** Read verified provider status and only the current operator's short-lived device code.
 * @param context - Authenticated dashboard operator.
 * @returns Safe health and owned login progress; credentials never enter the product database.
 */
export async function readChatgptConnection(context: MiraContext) {
    const [runtime] = await context.client<
        { chatgpt: unknown; fresh: boolean }[]
    >`SELECT chatgpt,heartbeat_at>now()-interval '45 seconds' AS fresh FROM mira_runtime_status WHERE id=1`;
    const parsed = v.safeParse(miraChatgptStatusSchema, runtime?.chatgpt);
    const status =
        runtime?.fresh &&
        parsed.success &&
        Date.now() - new Date(parsed.output.checkedAt).getTime() < 90_000
            ? parsed.output
            : { state: "error" as const, checkedAt: null };
    const [login] = await context.client<
        ChatgptLogin[]
    >`SELECT request_id AS "requestId",owner,state,CASE WHEN state='waiting' AND expires_at>now() AND ${runtime?.fresh === true} THEN verification_url END AS "verificationUrl",CASE WHEN state='waiting' AND expires_at>now() AND ${runtime?.fresh === true} THEN user_code END AS "userCode",message,expires_at::text AS "expiresAt" FROM mira_chatgpt_login WHERE id=1 AND owner=${context.owner}`;
    return {
        ...status,
        message: chatgptStatusMessage(status.state),
        online: runtime?.fresh === true,
        login: login ?? null,
    };
}

/** Queue one shared-provider login from the authorized dashboard, reusing an active owned request.
 * @param context - Human operator whose shared-runtime permission was checked by the route.
 * @returns The durable request identity; refreshes never start duplicate login processes.
 */
export async function requestChatgptLogin(context: MiraContext) {
    if (context.run || context.actor !== `human:${context.owner}`)
        throw new MiraFailure("FORBIDDEN", "Only an operator can reconnect ChatGPT.");
    const current = await readChatgptConnection(context);
    if (!current.online)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "Mira is offline. Reconnect the executor before signing in."
        );
    return context.client.begin(async (query) => {
        const [request] = await query<
            { requestId: string }[]
        >`INSERT INTO mira_chatgpt_login(id,request_id,owner,state,expires_at) VALUES(1,${crypto.randomUUID()},${context.owner},'requested',now()+interval '10 minutes') ON CONFLICT(id) DO UPDATE SET request_id=EXCLUDED.request_id,owner=EXCLUDED.owner,state='requested',expires_at=EXCLUDED.expires_at,worker_id=NULL,verification_url=NULL,user_code=NULL,message=NULL WHERE mira_chatgpt_login.state IN ('completed','failed','cancelled') RETURNING request_id AS "requestId"`;
        if (request) {
            await auditMira(query, context, "chatgpt.login_requested", request.requestId);
            return request;
        }
        const [existing] = await query<
            { requestId: string }[]
        >`SELECT request_id AS "requestId" FROM mira_chatgpt_login WHERE id=1 AND owner=${context.owner}`;
        if (!existing)
            throw new MiraFailure(
                "CONFLICT",
                "Another operator is signing in to the shared ChatGPT connection."
            );
        return existing;
    });
}

/** Cancel an owned login request; the worker stops its native flow on the next poll.
 * @param context - Authorized initiating operator.
 * @param requestId - Exact displayed request, protecting a later login from stale clicks.
 * @returns Completion without changing queued messages.
 */
export async function cancelChatgptLogin(
    context: MiraContext,
    requestId: string
): Promise<void> {
    await context.client`UPDATE mira_chatgpt_login SET state='cancelled',verification_url=NULL,user_code=NULL,message='Sign-in cancelled.' WHERE id=1 AND owner=${context.owner} AND request_id=${requestId} AND state IN ('requested','starting','waiting')`;
}
