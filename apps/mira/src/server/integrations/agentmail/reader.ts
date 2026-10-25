import * as v from "valibot";

import { integrationJson } from "../http";
import type { AgentMailReadConfiguration } from "./configuration";
import {
    agentMailContentSchema,
    agentMailIdSchema,
    agentMailEventPageSchema,
    agentMailMessageSchema,
    type AgentMailMessage,
    agentMailMessagePageSchema,
    ordinaryReceivedMail,
} from "./schema";

export interface PendingMailScan {
    messageId: string;
    released: boolean;
    firstSeenAt: string;
}

/** Fixed-origin, bounded AgentMail reads for one server-provisioned inbox. */
export class AgentMailReader {
    private readonly configuration: AgentMailReadConfiguration;
    private readonly request: typeof fetch;
    /**
     * Bind requests to the provisioned inbox and credential.
     * @param configuration - Private executor settings, never chosen by model input.
     * @param request - HTTP transport; replace only in synthetic tests.
     */
    constructor(
        configuration: AgentMailReadConfiguration,
        request: typeof fetch = fetch
    ) {
        this.configuration = configuration;
        this.request = request;
    }

    private async get(
        suffix: string,
        query: URLSearchParams,
        signal: AbortSignal,
        missingAllowed = false
    ): Promise<unknown> {
        const inbox = encodeURIComponent(this.configuration.inboxId);
        const url = new URL(`https://api.agentmail.to/v0/inboxes/${inbox}${suffix}`);
        url.search = query.toString();
        const response = await this.request(url, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${this.configuration.apiKey}`,
                Accept: "application/json",
            },
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (missingAllowed && response.status === 404) {
            await response.body?.cancel();
            return null;
        }
        return integrationJson(response, 2_097_152);
    }

    /**
     * Read one bounded page for catch-up; the caller persists its cursor only after acceptance.
     * @param input - Fixed time window and optional provider page cursor.
     * @param signal - Cancellation for the owning service operation.
     * @returns Validated metadata from the configured inbox only.
     */
    async list(
        input: { after: string; before: string; cursor?: string | undefined },
        signal: AbortSignal
    ) {
        const parsed = v.parse(
            v.strictObject({
                after: v.pipe(v.string(), v.isoTimestamp()),
                before: v.pipe(v.string(), v.isoTimestamp()),
                cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
            }),
            input
        );
        const query = new URLSearchParams({
            limit: "100",
            after: parsed.after,
            before: parsed.before,
            ascending: "true",
            labels: "received",
        });
        if (parsed.cursor) query.set("page_token", parsed.cursor);
        const result = v.parse(
            agentMailMessagePageSchema,
            await this.get("/messages", query, signal)
        );
        if (
            result.messages.some(
                (message) => message.inbox_id !== this.configuration.inboxId
            )
        )
            throw new Error("AgentMail returned a different inbox.");
        return result;
    }

    /**
     * Recover from provider-ordered inbox events, stopping at the saved event identity.
     * @param input - Retention window, last completed event identity and optional page cursor.
     * @param signal - Service cancellation; the complete page also has a 30-second budget.
     * @returns Current eligible metadata with original receipt times, head identity and continuation.
     */
    async recover(
        input: {
            after: string;
            before: string;
            cursor?: string | undefined;
            anchor?: string | null;
            pending?: PendingMailScan[];
        },
        signal: AbortSignal
    ): Promise<{
        messages: (AgentMailMessage & { event_created_at?: string })[];
        next_page_token?: string | null | undefined;
        head?: string | null;
        pending?: PendingMailScan[];
        checked?: string[];
    }> {
        const after = Date.parse(input.after),
            before = Date.parse(input.before);
        if (!Number.isFinite(after) || !Number.isFinite(before) || after > before)
            throw new Error("Invalid recovery window.");
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        const query = new URLSearchParams({ limit: "25", ascending: "false" });
        if (input.cursor) query.set("page_token", input.cursor);
        const page = v.parse(
            agentMailEventPageSchema,
            await this.get("/events", query, bounded)
        );
        if (page.events.some((event) => event.inbox_id !== this.configuration.inboxId))
            throw new Error("AgentMail returned a different inbox.");
        const boundary = input.anchor
            ? page.events.findIndex((event) => event.event_id === input.anchor)
            : -1;
        const unseen = boundary < 0 ? page.events : page.events.slice(0, boundary);
        // Only event IDs define feed order. Timestamps bound retention, never pagination.
        const eligibleEvents = unseen.filter(
            (event) =>
                Date.parse(event.event_at) >= after &&
                ((event.event_type === "label.added" && event.label === "received") ||
                    (event.event_type === "label.removed" &&
                        event.label === "agent-armor-held"))
        );
        const retries = (input.pending ?? []).slice(0, 10);
        const ids = [
            ...new Set([
                ...retries.map((entry) => entry.messageId),
                ...eligibleEvents.map((event) => event.message_id),
            ]),
        ];
        const pending: PendingMailScan[] = [];
        const messages: (AgentMailMessage & { event_created_at?: string })[] = [];
        for (let offset = 0; offset < ids.length; offset += 5) {
            bounded.throwIfAborted();
            const batch = await Promise.all(
                ids.slice(offset, offset + 5).map(async (id) => {
                    const raw = await this.get(
                        `/messages/${encodeURIComponent(id)}`,
                        new URLSearchParams(),
                        bounded,
                        true
                    );
                    if (raw === null) return null;
                    const message = v.parse(agentMailMessageSchema, raw);
                    if (
                        message.inbox_id !== this.configuration.inboxId ||
                        message.message_id !== id
                    )
                        throw new Error("AgentMail returned a different message.");
                    const previous = retries.find((entry) => entry.messageId === id);
                    const released =
                        previous?.released === true ||
                        eligibleEvents.some(
                            (event) =>
                                event.message_id === id &&
                                event.event_type === "label.removed"
                        );
                    if (
                        ["pending", "unavailable"].includes(
                            message.agent_armor?.status ?? ""
                        )
                    ) {
                        pending.push({
                            messageId: id,
                            released,
                            firstSeenAt:
                                previous?.firstSeenAt ?? new Date().toISOString(),
                        });
                        return null;
                    }
                    const releaseAt = message.agent_armor?.manual_override?.released_at;
                    if (released && !releaseAt) return null;
                    return {
                        ...message,
                        event_created_at: released ? releaseAt! : message.created_at,
                    };
                })
            );
            messages.push(
                ...batch.filter(
                    (
                        message
                    ): message is AgentMailMessage & { event_created_at: string } =>
                        message !== null && ordinaryReceivedMail(message)
                )
            );
        }
        bounded.throwIfAborted();
        return {
            messages,
            pending,
            checked: ids,
            head: page.events[0]?.event_id ?? null,
            next_page_token: boundary >= 0 ? null : page.next_page_token,
        };
    }

    /**
     * Resolve the latest provider message without trusting a selected message's timestamp.
     * @param threadId - Thread identity within the configured inbox.
     * @param signal - Run or dispatch cancellation; one bounded provider read is performed.
     * @returns The current reply target, including sent messages in the same thread.
     */
    async latestMessageId(threadId: string, signal: AbortSignal): Promise<string> {
        const id = v.parse(agentMailIdSchema, threadId);
        const thread = v.parse(
            v.object({
                inbox_id: agentMailIdSchema,
                thread_id: agentMailIdSchema,
                last_message_id: agentMailIdSchema,
            }),
            await this.get(
                `/threads/${encodeURIComponent(id)}`,
                new URLSearchParams({ limit: "1" }),
                signal
            )
        );
        if (thread.inbox_id !== this.configuration.inboxId || thread.thread_id !== id)
            throw new Error("AgentMail returned a different thread.");
        return thread.last_message_id;
    }

    /**
     * Fetch passive mail content; messages cannot grant tools, send authority or credentials.
     * @param messageId - Validated provider identifier within the configured inbox.
     * @param signal - Cancellation for the current product run.
     * @returns A bounded text/HTML-as-text excerpt and explicit truncation metadata.
     */
    async read(messageId: string, signal: AbortSignal) {
        const id = v.parse(agentMailIdSchema, messageId);
        const message = v.parse(
            agentMailContentSchema,
            await this.get(
                `/messages/${encodeURIComponent(id)}`,
                new URLSearchParams(),
                signal
            )
        );
        if (message.inbox_id !== this.configuration.inboxId || message.message_id !== id)
            throw new Error("AgentMail returned a different message.");
        if (!ordinaryReceivedMail(message))
            throw new Error("This message is not eligible for automatic reading.");
        const plain = [message.extracted_text, message.text].find((value) =>
            value?.trim()
        );
        const content =
            plain ??
            [message.extracted_html, message.html].find((value) => value?.trim()) ??
            "";
        return {
            messageId: id,
            threadId: message.thread_id,
            from: message.from,
            replyTo: message.reply_to,
            to: message.to,
            cc: message.cc,
            subject: message.subject,
            format: plain === undefined ? "untrusted_html_text" : "untrusted_text",
            content: content.slice(0, 48_000),
            truncated: content.length > 48_000,
        };
    }
}
