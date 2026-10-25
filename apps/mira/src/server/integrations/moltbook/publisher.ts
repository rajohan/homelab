import {
    miraSocialContentSchema,
    type MiraSocialContent,
} from "@homelab/contracts/miraSocial";
import * as v from "valibot";

import { integrationJson } from "../http";
import { moltbookIdSchema, type MoltbookReadConfiguration } from "./configuration";
import { MoltbookReader } from "./reader";

const verificationSchema = v.object({
    verification_code: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
    challenge_text: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
    expires_at: v.pipe(v.string(), v.isoTimestamp()),
});
const itemSchema = v.object({
    id: moltbookIdSchema,
    verification_status: v.optional(v.unknown()),
    verification: v.optional(v.unknown()),
});
export interface MoltbookWriteReceipt {
    id: string;
    verification: { code: string; challenge: string; expiresAt: string } | null;
    status: "submitted" | "verification_required" | "needs_attention";
}

/** A provider-confirmed rejection before creation; only the durable queue may schedule a later attempt. */
export class MoltbookRateLimit extends Error {
    readonly retryAt: Date;
    /**
     * Retain a bounded retry time without provider response text.
     * @param retryAt - Earliest allowed retry instant.
     */
    constructor(retryAt: Date) {
        super("Moltbook rate limit reached.");
        this.retryAt = retryAt;
    }
}

/** Fixed-origin write transport. Callers must supply exact durable approval and a fresh guard before every mutation. */
export class MoltbookPublisher {
    private readonly configuration: MoltbookReadConfiguration;
    private readonly request: typeof fetch;
    /**
     * Bind a dedicated publication credential to the configured agent identity.
     * @param configuration - Operator-owned identity and credentials, never model arguments.
     * @param request - Injectable transport for synthetic qualification.
     */
    constructor(configuration: MoltbookReadConfiguration, request: typeof fetch = fetch) {
        if (!configuration.publishApiKey)
            throw new Error("Moltbook publishing is not provisioned.");
        this.configuration = configuration;
        this.request = request;
    }
    /**
     * Verify the actual publication credential belongs to the selected agent before claiming a write.
     * @param signal - Cancellation and bounded network deadline.
     * @returns Completion after fixed-endpoint identity validation.
     */
    async preflight(signal: AbortSignal): Promise<void> {
        await new MoltbookReader(
            { ...this.configuration, apiKey: this.configuration.publishApiKey! },
            this.request
        ).profile(signal);
    }
    private async post(
        path: string,
        body: unknown,
        signal: AbortSignal
    ): Promise<unknown> {
        signal.throwIfAborted();
        const response = await this.request(`https://www.moltbook.com/api/v1/${path}`, {
            method: "POST",
            redirect: "error",
            credentials: "omit",
            headers: {
                Authorization: `Bearer ${this.configuration.publishApiKey}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (response.status === 429) {
            const retry = response.headers.get("retry-after");
            await response.body?.cancel();
            const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 1800;
            throw new MoltbookRateLimit(
                new Date(Date.now() + Math.min(Math.max(seconds, 20), 86_400) * 1000)
            );
        }
        return integrationJson(response, 256 * 1024);
    }
    /**
     * Create exactly one approved text post or comment; errors must never be blindly replayed.
     * @param content - Exact reviewed target and text.
     * @param signal - Cancellation covering headers and bounded response bytes.
     * @param guard - Durable permission and attempt check immediately before the mutation.
     * @returns Known provider identity and explicit verification state, never proof of public visibility.
     */
    async create(
        content: MiraSocialContent,
        signal: AbortSignal,
        guard: () => Promise<void>
    ): Promise<MoltbookWriteReceipt> {
        const parsed = v.parse(miraSocialContentSchema, content);
        await guard();
        const raw = await this.post(
            parsed.kind === "post"
                ? "posts"
                : `posts/${encodeURIComponent(parsed.postId)}/comments`,
            parsed.kind === "post"
                ? {
                      submolt_name: parsed.community,
                      title: parsed.title,
                      content: parsed.text,
                      type: "text",
                  }
                : {
                      content: parsed.text,
                      ...(parsed.parentId ? { parent_id: parsed.parentId } : {}),
                  },
            signal
        );
        const envelope = v.parse(
            v.object({
                success: v.literal(true),
                post: v.optional(itemSchema),
                comment: v.optional(itemSchema),
                verification_required: v.optional(v.unknown()),
                verification: v.optional(v.unknown()),
            }),
            raw
        );
        const item = parsed.kind === "post" ? envelope.post : envelope.comment;
        if (!item) throw new Error("Moltbook returned no content receipt.");
        const source = item.verification ?? envelope.verification;
        const checked =
            source === null || source === undefined
                ? null
                : v.safeParse(verificationSchema, source);
        if (checked && !checked.success)
            return { id: item.id, verification: null, status: "needs_attention" };
        const challenge = checked?.success ? checked.output : null;
        const status = item.verification_status;
        if (challenge && (status === undefined || status === "pending"))
            return {
                id: item.id,
                status: "verification_required",
                verification: {
                    code: challenge.verification_code,
                    challenge: challenge.challenge_text,
                    expiresAt: challenge.expires_at,
                },
            };
        return {
            id: item.id,
            verification: null,
            status:
                (envelope.verification_required === false && status === undefined) ||
                (envelope.verification_required === undefined && status === undefined) ||
                (status === "verified" && envelope.verification_required !== true)
                    ? "submitted"
                    : "needs_attention",
        };
    }
    /**
     * Submit one operator answer for a previously captured challenge without creating content again.
     * @param input - Stored provider challenge and exact approved content identity.
     * @param signal - Cancellation covering the entire request.
     * @param guard - Current durable permission, expiry and attempt ownership check.
     * @returns Completion only when the provider confirms the expected content identity.
     */
    async verify(
        input: { code: string; answer: string; kind: "post" | "comment"; id: string },
        signal: AbortSignal,
        guard: () => Promise<void>
    ): Promise<void> {
        if (!/^-?\d{1,12}\.\d{2}$/.test(input.answer))
            throw new Error("Invalid verification answer.");
        await guard();
        const result = v.parse(
            v.object({
                success: v.literal(true),
                content_type: v.picklist(["post", "comment"]),
                content_id: moltbookIdSchema,
            }),
            await this.post(
                "verify",
                { verification_code: input.code, answer: input.answer },
                signal
            )
        );
        if (result.content_type !== input.kind || result.content_id !== input.id)
            throw new Error(
                "Moltbook verification returned a different content identity."
            );
    }
}
