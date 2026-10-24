import type { SQL } from "bun";
import { Webhook } from "svix";
import * as v from "valibot";

import { recordMiraEvent } from "../../data/events";
import { agentMailBindingStatus } from "../../data/integrations";
import type { AgentMailBinding, AgentMailHookConfiguration } from "./configuration";
import {
    agentMailIdSchema,
    agentMailMessageSchema,
    ordinaryReceivedMail,
} from "./schema";

const envelopeSchema = v.object({ event_type: v.string(), event_id: agentMailIdSchema });
const receivedSchema = v.object({
    ...envelopeSchema.entries,
    message: v.object({
        inbox_id: agentMailIdSchema,
        message_id: agentMailIdSchema,
        created_at: v.pipe(v.string(), v.isoTimestamp()),
        labels: v.optional(agentMailMessageSchema.entries.labels, ["received"]),
        agent_armor: agentMailMessageSchema.entries.agent_armor,
    }),
});

/**
 * Store one provider-verified message reference after delivery or catch-up.
 * @param client - Mira product database; acknowledgement must follow this transaction.
 * @param binding - Server-owned inbox-to-account mapping.
 * @param messageId - Validated inbox-local message identity.
 * @param observedAt - Original provider receipt time for pause eligibility.
 * @param availableAt - Release/event time for delivery freshness, defaulting to receipt time.
 * @returns Whether a new event was accepted; webhook retries and catch-up share the key.
 */
export async function acceptAgentMailMessage(
    client: SQL,
    binding: AgentMailBinding,
    messageId: string,
    observedAt?: Date,
    availableAt?: Date
): Promise<boolean> {
    return client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:controls:${binding.owner}`}, 0))`;
        const status = await agentMailBindingStatus(query, binding);
        if (!status.matched || (status.enabled && !status.granted))
            throw new Error("AgentMail inbox binding has not been confirmed.");
        return recordAgentMailMessage(query, binding, messageId, observedAt, availableAt);
    });
}

/**
 * Accept a verified reference in the same transaction as a recovery cursor.
 * @param query - Owning transaction; failures roll back both messages and pagination.
 * @param binding - Server-provisioned account and inbox.
 * @param messageId - Verified provider identity.
 * @param observedAt - Original receipt time used to exclude mail from deliberate pauses.
 * @param availableAt - Fresh release/event time, independent of pause eligibility.
 * @returns Whether this reference was newly recorded.
 */
export async function recordAgentMailMessage(
    query: Parameters<typeof recordMiraEvent>[0],
    binding: AgentMailBinding,
    messageId: string,
    observedAt?: Date,
    availableAt?: Date
): Promise<boolean> {
    const id = v.parse(agentMailIdSchema, messageId);
    const reference = JSON.stringify({ inboxId: binding.inboxId, messageId: id });
    const key = new Bun.CryptoHasher("sha256").update(reference).digest("hex");
    return recordMiraEvent(query, {
        owner: binding.owner,
        kind: "agentmail",
        key,
        reference,
        ...(observedAt ? { eligibilityAt: observedAt } : {}),
        observedAt: availableAt ?? observedAt ?? new Date(),
    });
}

/**
 * Verify the exact raw body with AgentMail's Svix contract before inspecting its contents.
 * @param raw - Bounded original request bytes decoded as UTF-8, never reserialized JSON.
 * @param headers - Svix delivery headers from the transport request.
 * @param configuration - The webhook's own signing secret and explicit inbox binding.
 * @returns An ordinary received-message reference, or null for other valid event types/inboxes.
 */
export function verifyAgentMailWebhook(
    raw: string,
    headers: Headers,
    configuration: AgentMailHookConfiguration
): { messageId: string; observedAt: Date; availableAt: Date } | null {
    if (Buffer.byteLength(raw, "utf8") > 262_144)
        throw new Error("AgentMail event is too large.");
    const values = Object.fromEntries(
        ["svix-id", "svix-timestamp", "svix-signature"].map((name) => [
            name,
            headers.get(name) ?? "",
        ])
    );
    let payload: unknown;
    try {
        new Webhook(configuration.signingSecret).verify(raw, values);
        payload = JSON.parse(raw) as unknown;
    } catch {
        throw new Error("AgentMail signature verification failed.");
    }
    const envelope = v.parse(envelopeSchema, payload);
    if (envelope.event_type !== "message.received") return null;
    const event = v.parse(receivedSchema, payload);
    return event.message.inbox_id === configuration.inboxId &&
        ordinaryReceivedMail(event.message)
        ? {
              messageId: event.message.message_id,
              observedAt: new Date(event.message.created_at),
              availableAt: new Date(
                  event.message.agent_armor?.manual_override?.released_at ??
                      event.message.created_at
              ),
          }
        : null;
}
