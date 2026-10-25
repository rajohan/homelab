import * as v from "valibot";

import { integrationJson } from "../http";
import { moltbookCommentsInputSchema, parseMoltbookComments } from "./comments";
import { moltbookIdSchema, type MoltbookReadConfiguration } from "./configuration";

const text = (maximum: number) => v.pipe(v.string(), v.maxLength(maximum));
const postSchema = v.object({
    id: moltbookIdSchema,
    title: v.optional(text(300), ""),
    content: v.nullish(text(40_000), ""),
    author: v.optional(v.object({ name: text(128) })),
    submolt: v.optional(v.object({ name: text(128) })),
    created_at: v.optional(text(100)),
});
const profileSchema = v.object({
    success: v.optional(v.literal(true)),
    agent: v.object({
        name: text(128),
        description: v.nullish(text(10_000), ""),
        karma: v.optional(v.number()),
        posts_count: v.optional(v.number()),
        comments_count: v.optional(v.number()),
        is_claimed: v.optional(v.boolean()),
    }),
});
const feedSchema = v.object({
    success: v.optional(v.literal(true)),
    posts: v.pipe(v.array(postSchema), v.maxLength(25)),
    has_more: v.optional(v.boolean(), false),
    next_cursor: v.nullish(text(4096), null),
});
const namedSchema = v.object({ name: text(128) });
const recentPostSchema = v.object({
    id: moltbookIdSchema,
    title: text(300),
    content_preview: v.nullish(text(40_000), null),
    verification_status: v.nullish(text(64), null),
    is_deleted: v.nullish(v.boolean(), null),
    is_spam: v.nullish(v.boolean(), null),
    submolt: v.optional(namedSchema),
    created_at: v.optional(text(100)),
});
const recentCommentSchema = v.object({
    id: moltbookIdSchema,
    content: v.nullish(text(40_000), null),
    verification_status: v.nullish(text(64), null),
    is_deleted: v.nullish(v.boolean(), null),
    is_spam: v.nullish(v.boolean(), null),
    created_at: v.optional(text(100)),
    post: v.object({
        id: moltbookIdSchema,
        title: text(300),
        submolt: v.optional(namedSchema),
    }),
});
const activitySchema = v.object({
    success: v.optional(v.literal(true)),
    agent: namedSchema,
    recentPosts: v.pipe(v.array(recentPostSchema), v.maxLength(25)),
    recentComments: v.pipe(v.array(recentCommentSchema), v.maxLength(25)),
});
const feedInput = v.strictObject({
    sort: v.optional(v.picklist(["new", "hot", "top"]), "new"),
    cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});

/**
 * Read bounded passive Moltbook content from one provisioned identity; no method publishes or acknowledges activity.
 */
export class MoltbookReader {
    private readonly configuration: MoltbookReadConfiguration;
    private readonly request: typeof fetch;
    /**
     * Bind a fixed provider origin and account, with injectable HTTP only for qualification.
     * @param configuration - Service-provisioned owner, expected identity and API credential.
     * @param request - HTTP transport; no URL can come from model or provider content.
     */
    constructor(configuration: MoltbookReadConfiguration, request: typeof fetch = fetch) {
        this.configuration = configuration;
        this.request = request;
    }

    private async json(path: string, signal: AbortSignal): Promise<unknown> {
        signal.throwIfAborted();
        const response = await this.request(`https://www.moltbook.com/api/v1/${path}`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${this.configuration.apiKey}`,
                Accept: "application/json",
            },
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        return integrationJson(response, 2 * 1024 * 1024);
    }

    /**
     * Verify the credential's current agent before returning a narrow profile without human-owner fields.
     * @param signal - Run deadline or service shutdown.
     * @returns Passive profile fields for exactly the configured agent; account mismatches fail closed.
     */
    async profile(signal: AbortSignal) {
        const { agent } = v.parse(profileSchema, await this.json("agents/me", signal));
        if (agent.name !== this.configuration.agentName)
            throw new Error("Moltbook credential does not match the configured account.");
        return {
            name: agent.name,
            description: agent.description.slice(0, 2000),
            karma: agent.karma ?? null,
            posts: agent.posts_count ?? null,
            comments: agent.comments_count ?? null,
            claimed: agent.is_claimed ?? null,
        };
    }

    /**
     * Read one bounded personalized feed page after checking the credential's identity.
     * @param input - Supported sort and opaque continuation; page size is fixed by the service.
     * @param signal - Cancellation covering account verification, headers and response body.
     * @returns At most 25 passive excerpts and the provider's cursor; no instructions are executed.
     */
    async feed(input: v.InferInput<typeof feedInput>, signal: AbortSignal) {
        const parsed = v.parse(feedInput, input);
        await this.profile(signal);
        const params = new URLSearchParams({ sort: parsed.sort, limit: "25" });
        if (parsed.cursor) params.set("cursor", parsed.cursor);
        const page = v.parse(
            feedSchema,
            await this.json(`feed?${params.toString()}`, signal)
        );
        if (page.has_more && !page.next_cursor)
            throw new Error("Moltbook omitted the next feed cursor.");
        return {
            posts: page.posts.map((post) => ({
                id: post.id,
                title: post.title,
                excerpt: post.content.slice(0, 800),
                truncated: post.content.length > 800,
                author: post.author?.name ?? null,
                community: post.submolt?.name ?? null,
                createdAt: post.created_at ?? null,
            })),
            nextCursor: page.has_more ? page.next_cursor : null,
        };
    }

    /**
     * Read one explicitly selected post as passive text after verifying the configured account.
     * @param id - Provider post identifier; URLs and paths are not accepted.
     * @param signal - Run cancellation and body timeout.
     * @returns Bounded post content with explicit truncation and no provider-supplied commands or account secrets.
     */
    async post(id: string, signal: AbortSignal) {
        const parsed = v.parse(moltbookIdSchema, id);
        await this.profile(signal);
        const { post } = v.parse(
            v.object({ success: v.optional(v.literal(true)), post: postSchema }),
            await this.json(`posts/${encodeURIComponent(parsed)}`, signal)
        );
        if (post.id !== parsed) throw new Error("Moltbook returned a different post.");
        return {
            id: post.id,
            title: post.title,
            content: post.content.slice(0, 16_000),
            truncated: post.content.length > 16_000,
            author: post.author?.name ?? null,
            community: post.submolt?.name ?? null,
            createdAt: post.created_at ?? null,
        };
    }

    /**
     * Read the configured agent's recent posts and comments with provider-reported moderation metadata without checking in or acknowledging activity.
     * @param signal - Cancellation across credential verification and the public profile request.
     * @returns Narrow recent activity only; the provider exposes no history cursor for these lists.
     */
    async activity(signal: AbortSignal) {
        await this.profile(signal);
        const params = new URLSearchParams({ name: this.configuration.agentName });
        const page = v.parse(
            activitySchema,
            await this.json(`agents/profile?${params.toString()}`, signal)
        );
        if (page.agent.name !== this.configuration.agentName)
            throw new Error("Moltbook returned a different activity account.");
        return {
            name: page.agent.name,
            completeHistory: false,
            posts: page.recentPosts.map((post) => ({
                id: post.id,
                title: post.title,
                preview: post.is_deleted
                    ? null
                    : (post.content_preview?.slice(0, 800) ?? null),
                previewTruncated:
                    post.is_deleted || post.content_preview === null
                        ? null
                        : post.content_preview.length > 800,
                verificationStatus: post.verification_status,
                deleted: post.is_deleted,
                spam: post.is_spam,
                community: post.submolt?.name ?? null,
                createdAt: post.created_at ?? null,
            })),
            comments: page.recentComments.map((comment) => ({
                id: comment.id,
                excerpt: comment.is_deleted
                    ? null
                    : (comment.content?.slice(0, 800) ?? null),
                truncated:
                    comment.is_deleted || comment.content === null
                        ? null
                        : comment.content.length > 800,
                verificationStatus: comment.verification_status,
                deleted: comment.is_deleted,
                spam: comment.is_spam,
                createdAt: comment.created_at ?? null,
                post: {
                    id: comment.post.id,
                    title: comment.post.title,
                    community: comment.post.submolt?.name ?? null,
                },
            })),
        };
    }

    /**
     * Read one page of root comments and its provider-returned replies from a selected post.
     * @param input - Post identifier, supported root sort and opaque root continuation.
     * @param signal - Cancellation covering identity, headers and bounded response bytes.
     * @returns Passive excerpts with checked ancestry; root continuation cannot recover locally omitted replies.
     */
    async comments(
        input: v.InferInput<typeof moltbookCommentsInputSchema>,
        signal: AbortSignal
    ) {
        const parsed = v.parse(moltbookCommentsInputSchema, input);
        await this.profile(signal);
        const params = new URLSearchParams({ sort: parsed.sort, limit: "25" });
        if (parsed.cursor) params.set("cursor", parsed.cursor);
        return parseMoltbookComments(
            await this.json(
                `posts/${encodeURIComponent(parsed.id)}/comments?${params.toString()}`,
                signal
            ),
            parsed
        );
    }
}
