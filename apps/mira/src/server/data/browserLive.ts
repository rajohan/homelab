import { unrestrictedBrowserSites } from "@homelab/contracts/miraBrowser";
import * as v from "valibot";

import { browserLiveIdentitySchema } from "../browsing/liveSocket";
import { lockBrowserOwner, readBrowserAccess } from "./browserAccess";
import { type MiraContext, MiraFailure } from "./context";

/** Resolve one signed-in operator's current display authority.
 * @param context - Server-authenticated human; model and automation contexts are rejected.
 * @param input - Access and controller generation selected by the console.
 * @returns Private process routing and the server-enforced view/control mode.
 */
export async function readMiraBrowserLive(context: MiraContext, input: unknown) {
    const identity = v.parse(browserLiveIdentitySchema, input);
    if (
        context.run ||
        context.owner !== identity.owner ||
        context.actor !== `human:${context.owner}`
    )
        throw new MiraFailure(
            "FORBIDDEN",
            "Browser display requires its signed-in operator."
        );
    return context.client.begin(async (query) => {
        await lockBrowserOwner(query, context.owner);
        const access = await readBrowserAccess(query, context.owner, identity.accessId);
        const [row] = await query<
            { epoch: string; hostId: string; processId: string; containerId: string }[]
        >`
            SELECT c.epoch,p.host_id AS "hostId",p.id AS "processId",p.container_id AS "containerId"
            FROM mira_browser_consoles c JOIN mira_browser_processes p ON p.access_id=c.access_id
            WHERE c.access_id=${identity.accessId} AND p.state='active' AND p.phase='created'
            AND p.lease_expires_at>clock_timestamp() AND p.container_id IS NOT NULL`;
        if (
            !access?.available ||
            access.state !== "active" ||
            !access.policy ||
            !unrestrictedBrowserSites(access.policy.origins) ||
            !row ||
            row.epoch !== identity.epoch
        )
            throw new MiraFailure(
                "PRECONDITION_FAILED",
                "Browser display is starting, stopped or changed."
            );
        return {
            ...row,
            control: access.controller === "human" && access.mode === "control",
        };
    });
}
