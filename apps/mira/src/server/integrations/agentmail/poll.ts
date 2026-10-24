import type { SQL } from "bun";

import { agentMailBindingHash, type AgentMailBinding } from "./configuration";
import type { AgentMailReader } from "./reader";
import { ordinaryReceivedMail } from "./schema";
import { recordAgentMailMessage } from "./webhook";

interface PollClaim {
    token: string;
    version: number;
    after: Date;
    before: Date;
    cursor: string | null;
}

async function claim(client: SQL, binding: AgentMailBinding): Promise<PollClaim | null> {
    return client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${binding.owner}`}, 0))`;
        const [control] = await query<
            {
                enabled: boolean;
                version: number;
                changedAt: Date;
                activatedAt: Date | null;
            }[]
        >`SELECT enabled, version, changed_at AS "changedAt", binding_activated_at AS "activatedAt" FROM mira_switches WHERE owner = ${binding.owner} AND key = 'integration:agentmail' AND binding_hash = ${agentMailBindingHash(binding)}`;
        if (!control?.enabled) return null;
        const now = new Date();
        const [previous] = await query<
            { binding: string; version: number }[]
        >`SELECT binding, control_version AS version FROM mira_integration_state WHERE owner = ${binding.owner} AND key = 'agentmail' FOR UPDATE`;
        if (!previous || previous.binding !== binding.inboxId) {
            const start = new Date(control.activatedAt ?? control.changedAt);
            await query`INSERT INTO mira_integration_state (owner, key, binding, control_version, started_at, completed_through, next_attempt_at) VALUES (${binding.owner}, 'agentmail', ${binding.inboxId}, ${control.version}, ${start}, ${start}, now()) ON CONFLICT (owner, key) DO UPDATE SET binding = EXCLUDED.binding, control_version = EXCLUDED.control_version, started_at = EXCLUDED.started_at, completed_through = EXCLUDED.completed_through, window_end = NULL, cursor = NULL, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = EXCLUDED.next_attempt_at, last_success_at = NULL, message = NULL, heartbeat_at = now()`;
        } else if (previous.version !== control.version) {
            await query`UPDATE mira_integration_state SET control_version = ${control.version}, cursor = NULL, lease_token = NULL, lease_expires_at = NULL, next_attempt_at = now(), message = NULL WHERE owner = ${binding.owner} AND key = 'agentmail'`;
        }
        const token = crypto.randomUUID();
        const [row] = await query<
            { after: Date; before: Date; cursor: string | null }[]
        >`UPDATE mira_integration_state SET lease_token = ${token}, lease_expires_at = now() + interval '45 seconds', window_end = COALESCE(window_end, ${now}), heartbeat_at = now() WHERE owner = ${binding.owner} AND key = 'agentmail' AND next_attempt_at <= now() AND (lease_expires_at IS NULL OR lease_expires_at <= now()) RETURNING greatest(started_at, completed_through - interval '1 minute', COALESCE(window_end, ${now}) - interval '24 hours') AS after, window_end AS before, cursor`;
        return row ? { ...row, token, version: control.version } : null;
    });
}

/**
 * Reconcile one bounded inbox page, independently of model availability and infrastructure workers.
 * @param client - Product database; a fenced cursor survives service replacement.
 * @param binding - Provisioned account and inbox, never selected by model content.
 * @param reader - Fixed-origin provider reader; synthetic transport is injectable for tests.
 * @param signal - Service shutdown cancellation.
 * @returns Whether a page was committed; disabled, busy or backed-off readers return false.
 */
export async function pollAgentMail(
    client: SQL,
    binding: AgentMailBinding,
    reader: Pick<AgentMailReader, "recover">,
    signal: AbortSignal
): Promise<boolean> {
    signal.throwIfAborted();
    const claimed = await claim(client, binding);
    if (!claimed) return false;
    try {
        const page = await reader.recover(
            {
                after: new Date(claimed.after).toISOString(),
                before: new Date(claimed.before).toISOString(),
                ...(claimed.cursor ? { cursor: claimed.cursor } : {}),
            },
            signal
        );
        signal.throwIfAborted();
        if (page.next_page_token && page.next_page_token === claimed.cursor)
            throw new Error("AgentMail repeated a page cursor.");
        return await client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${binding.owner}`}, 0))`;
            const [owned] = await query<
                { owner: string }[]
            >`SELECT s.owner FROM mira_integration_state s JOIN mira_switches c ON c.owner = s.owner AND c.key = 'integration:agentmail' WHERE s.owner = ${binding.owner} AND s.key = 'agentmail' AND s.binding = ${binding.inboxId} AND s.lease_token = ${claimed.token} AND s.lease_expires_at > now() AND c.enabled AND c.version = ${claimed.version} AND c.binding_hash = ${agentMailBindingHash(binding)} FOR UPDATE OF s`;
            if (!owned) return false;
            for (const message of page.messages) {
                const at = new Date(message.created_at);
                if (message.inbox_id !== binding.inboxId) throw new Error("Wrong inbox.");
                if (at < claimed.after || at > claimed.before)
                    throw new Error("Message outside recovery window.");
                if (ordinaryReceivedMail(message))
                    await recordAgentMailMessage(query, binding, message.message_id, at);
            }
            const cursor = page.next_page_token ?? null;
            await query`UPDATE mira_integration_state SET cursor = ${cursor}, completed_through = CASE WHEN ${cursor}::text IS NULL THEN window_end ELSE completed_through END, window_end = CASE WHEN ${cursor}::text IS NULL THEN NULL ELSE window_end END, next_attempt_at = now() + CASE WHEN ${cursor}::text IS NULL THEN interval '1 minute' ELSE interval '0 seconds' END, lease_token = NULL, lease_expires_at = NULL, last_success_at = now(), heartbeat_at = now(), message = NULL WHERE owner = ${binding.owner} AND key = 'agentmail' AND lease_token = ${claimed.token}`;
            return true;
        });
    } catch {
        await client`UPDATE mira_integration_state SET lease_token = NULL, lease_expires_at = NULL, next_attempt_at = now() + interval '30 seconds', heartbeat_at = now(), cursor = NULL, message = 'AgentMail recovery could not complete. The saved window will be retried without duplicating accepted messages.' WHERE owner = ${binding.owner} AND key = 'agentmail' AND lease_token = ${claimed.token}`;
        return false;
    }
}
