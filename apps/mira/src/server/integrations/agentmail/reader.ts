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
     * Recover from receipt-ordered inbox events, stopping at the saved receipt boundary.
     * @param input - Durable receipt window and optional events pagination cursor.
     * @param signal - Service cancellation; the complete page also has a 30-second budget.
     * @returns Current eligible message metadata and a cursor only while recent events remain.
     */
    async recover(
        input: { after: string; before: string; cursor?: string | undefined },
        signal: AbortSignal
    ): Promise<{
        messages: AgentMailMessage[];
        next_page_token?: string | null | undefined;
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
        let previous = Infinity;
        for (const event of page.events) {
            const at = Date.parse(event.created_at);
            if (event.inbox_id !== this.configuration.inboxId)
                throw new Error("AgentMail returned a different inbox.");
            if (at > previous)
                throw new Error("AgentMail returned unordered inbox events.");
            previous = at;
        }
        const ids = [
            ...new Set(
                page.events
                    .filter((event) => {
                        const at = Date.parse(event.created_at);
                        return at >= after && at <= before;
                    })
                    .map((event) => event.message_id)
            ),
        ];
        const messages: AgentMailMessage[] = [];
        // Five requests at a time bound API concurrency and keep the page inside its lease.
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
                    return message;
                })
            );
            messages.push(
                ...batch.filter((message): message is AgentMailMessage => {
                    if (message === null) return false;
                    const at = Date.parse(message.created_at);
                    return at >= after && at <= before && ordinaryReceivedMail(message);
                })
            );
        }
        bounded.throwIfAborted();
        return {
            messages,
            next_page_token: page.events.some(
                (event) => Date.parse(event.created_at) < after
            )
                ? null
                : page.next_page_token,
        };
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
            from: message.from,
            subject: message.subject,
            format: plain === undefined ? "untrusted_html_text" : "untrusted_text",
            content: content.slice(0, 48_000),
            truncated: content.length > 48_000,
        };
    }
}
