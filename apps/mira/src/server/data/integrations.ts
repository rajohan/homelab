import * as v from "valibot";

import type { MiraContext } from "./context";

/**
 * Read the current operator's provisioned integrations without exposing credentials or other bindings.
 * @param context - Authenticated product owner.
 * @returns Configured availability and redacted recovery status; intentional pause stays separate.
 */
export async function listMiraIntegrations(context: MiraContext) {
    const [runtime] = await context.client<
        { integrations: unknown; fresh: boolean }[]
    >`SELECT integrations, heartbeat_at > now()-interval '45 seconds' AS fresh FROM mira_runtime_status WHERE id=1`;
    const catalog = v.safeParse(
        v.pipe(
            v.array(v.object({ owner: v.string(), key: v.string() })),
            v.maxLength(100)
        ),
        runtime?.integrations ?? []
    );
    const configured =
        catalog.success &&
        catalog.output.some(
            (entry) => entry.owner === context.owner && entry.key === "agentmail"
        );
    const [state] = await context.client<
        { message: string | null; lastSuccessAt: string | null }[]
    >`SELECT message,last_success_at::text AS "lastSuccessAt" FROM mira_integration_state WHERE owner=${context.owner} AND key='agentmail'`;
    return [
        {
            key: "integration:agentmail",
            title: "AgentMail",
            configured,
            ready: configured && runtime?.fresh === true,
            message: state?.message ?? null,
            lastSuccessAt: state?.lastSuccessAt ?? null,
        },
    ];
}
