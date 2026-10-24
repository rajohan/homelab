import {
    agentMailBindingHash,
    type AgentMailBinding,
} from "../integrations/agentmail/configuration";
import type { MiraContext, MiraQuery } from "./context";

/**
 * Compare the provisioned inbox across services and the operator's current grant.
 * @param query - Product connection or producer transaction.
 * @param binding - Dashboard or executor's explicit account/inbox configuration.
 * @returns Agreement and heartbeat state without disclosing addresses or credentials.
 */
export async function agentMailBindingStatus(
    query: MiraQuery,
    binding: AgentMailBinding
) {
    const hash = agentMailBindingHash(binding);
    const [runtime] = await query<
        { matched: boolean; fresh: boolean }[]
    >`SELECT integrations @> ${JSON.stringify([{ owner: binding.owner, key: "agentmail", bindingHash: hash }])}::text::jsonb AS matched, heartbeat_at > now()-interval '45 seconds' AS fresh FROM mira_runtime_status WHERE id=1`;
    const [control] = await query<
        { enabled: boolean; granted: boolean }[]
    >`SELECT enabled, binding_hash = ${hash} AS granted FROM mira_switches WHERE owner=${binding.owner} AND key='integration:agentmail'`;
    return {
        matched: runtime?.matched === true,
        fresh: runtime?.fresh === true,
        enabled: control?.enabled === true,
        granted: control?.granted === true,
    };
}

/**
 * Read the current operator's provisioned integrations without exposing credentials or other bindings.
 * @param context - Authenticated product owner.
 * @param binding - Dashboard's configured receiver, checked against the executor's inbox.
 * @returns Configured availability and redacted recovery status; intentional pause stays separate.
 */
export async function listMiraIntegrations(
    context: MiraContext,
    binding?: AgentMailBinding
) {
    const status =
        binding?.owner === context.owner
            ? await agentMailBindingStatus(context.client, binding)
            : null;
    const [state] = await context.client<
        { message: string | null; lastSuccessAt: string | null }[]
    >`SELECT message,last_success_at::text AS "lastSuccessAt" FROM mira_integration_state WHERE owner=${context.owner} AND key='agentmail'`;
    const configured = status?.matched === true;
    const confirmed = !status?.enabled || status.granted;
    let message = configured ? (state?.message ?? null) : null;
    if (status && !configured)
        message =
            "Dashboard and Mira must be configured with the same AgentMail inbox before enabling this integration.";
    else if (!confirmed)
        message = "Pause and enable AgentMail to confirm the new inbox binding.";
    return [
        {
            key: "integration:agentmail",
            title: "AgentMail",
            configured,
            ready: configured && status.fresh && confirmed,
            message,
            lastSuccessAt: configured ? (state?.lastSuccessAt ?? null) : null,
        },
    ];
}
