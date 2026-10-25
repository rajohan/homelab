import {
    agentMailBindingHash,
    type AgentMailBinding,
} from "../integrations/agentmail/configuration";
import type { HereNowBinding } from "../integrations/herenow/configuration";
import type { MoltbookBinding } from "../integrations/moltbook/configuration";
import type { MiraContext, MiraQuery } from "./context";
import { hereNowIntegrationStatus } from "./herenow";
import { moltbookIntegrationStatus } from "./moltbook";

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
        { matched: boolean; fresh: boolean; sendConfigured: boolean }[]
    >`SELECT integrations @> ${JSON.stringify([{ owner: binding.owner, key: "agentmail", bindingHash: hash }])}::text::jsonb AS matched, integrations @> ${JSON.stringify([{ owner: binding.owner, key: "agentmail", bindingHash: hash, sendConfigured: true }])}::text::jsonb AS "sendConfigured", heartbeat_at > now()-interval '45 seconds' AS fresh FROM mira_runtime_status WHERE id=1`;
    const [control] = await query<
        { enabled: boolean; granted: boolean }[]
    >`SELECT enabled, binding_hash = ${hash} AS granted FROM mira_switches WHERE owner=${binding.owner} AND key='integration:agentmail'`;
    return {
        matched: runtime?.matched === true,
        sendConfigured: runtime?.sendConfigured === true,
        fresh: runtime?.fresh === true,
        enabled: control?.enabled === true,
        granted: control?.granted === true,
    };
}

/**
 * Read the current operator's provisioned integrations without exposing credentials or other bindings.
 * @param context - Authenticated product owner.
 * @param binding - Dashboard's configured receiver, checked against the executor's inbox.
 * @param hereNow - Dashboard account mapping for website metadata.
 * @param moltbook - Dashboard account mapping for passive social reads.
 * @returns Configured availability and redacted recovery status; intentional pause stays separate.
 */
export async function listMiraIntegrations(
    context: MiraContext,
    binding?: AgentMailBinding,
    moltbook?: MoltbookBinding,
    hereNow?: HereNowBinding
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
            description: "Read incoming email and trigger enabled mail automations.",
            configured,
            ready: configured && status.fresh && confirmed,
            message,
            lastSuccessAt: configured ? (state?.lastSuccessAt ?? null) : null,
        },
        await moltbookIntegrationStatus(context, moltbook),
        await moltbookIntegrationStatus(context, moltbook, true),
        await hereNowIntegrationStatus(context, hereNow),
    ];
}

/**
 * Publish the running receiver's nonsecret inbox binding independently of browser requests.
 * @param query - Dashboard-owned database connection.
 * @param binding - Current configured receiver, or absent to revoke a previous configuration.
 * @returns Completion after the receiver's binding and liveness have committed.
 */
export async function publishAgentMailReceiver(
    query: MiraQuery,
    binding?: AgentMailBinding
): Promise<void> {
    const hash = binding ? agentMailBindingHash(binding) : null;
    await query`INSERT INTO mira_integration_receivers (key,binding_hash,heartbeat_at) VALUES ('agentmail',${hash},now()) ON CONFLICT (key) DO UPDATE SET binding_hash=EXCLUDED.binding_hash,heartbeat_at=EXCLUDED.heartbeat_at`;
}

/**
 * Fence executor reads when the running dashboard no longer confirms this inbox.
 * @param query - Current connection or owning transaction.
 * @param binding - The executor's fixed account/inbox mapping.
 * @returns Whether the receiver recently published the same binding.
 */
export async function agentMailReceiverCurrent(
    query: MiraQuery,
    binding: AgentMailBinding
): Promise<boolean> {
    const [receiver] = await query<
        { current: boolean }[]
    >`SELECT binding_hash=${agentMailBindingHash(binding)} AND heartbeat_at>now()-interval '45 seconds' AS current FROM mira_integration_receivers WHERE key='agentmail' FOR SHARE`;
    return receiver?.current === true;
}
