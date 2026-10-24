import {
    agentMailBindingHash,
    type AgentMailBinding,
} from "@homelab/mira/integrations/agentmail/configuration";
import type { SQL } from "bun";

const defaultBinding = { owner: "operator", inboxId: "synthetic@agentmail.to" };

/**
 * Provision matching synthetic dashboard/executor bindings in a disposable test database.
 * @param client - Isolated product test database.
 * @param binding - Synthetic account and inbox for the test.
 * @returns Receiver configuration containing a non-production signing key.
 */
export async function provisionTestAgentMail(
    client: SQL,
    binding: AgentMailBinding = defaultBinding
) {
    await client`INSERT INTO mira_runtime_status (id, worker_id, version, ready, heartbeat_at, integrations) VALUES (1, ${crypto.randomUUID()}, 'synthetic', true, now(), ${JSON.stringify([{ owner: binding.owner, key: "agentmail", bindingHash: agentMailBindingHash(binding) }])}::text::jsonb) ON CONFLICT (id) DO UPDATE SET integrations=EXCLUDED.integrations, heartbeat_at=now()`;
    return {
        ...binding,
        signingSecret: `whsec_${Buffer.from("synthetic-webhook-key-32-bytes-000").toString("base64")}`,
    };
}
