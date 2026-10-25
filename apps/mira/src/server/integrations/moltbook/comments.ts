import * as v from "valibot";

import { moltbookIdSchema } from "./configuration";

const sortSchema = v.picklist(["best", "new", "old"]);
export const moltbookCommentsInputSchema = v.strictObject({
    id: moltbookIdSchema,
    sort: v.optional(sortSchema, "new"),
    cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});
const text = (maximum: number) => v.pipe(v.string(), v.maxLength(maximum));
const pageSchema = v.object({
    success: v.optional(v.literal(true)),
    post_id: moltbookIdSchema,
    sort: sortSchema,
    comments: v.pipe(v.array(v.unknown()), v.maxLength(25)),
    has_more: v.boolean(),
    next_cursor: v.nullish(text(4096), null),
});
const commentSchema = v.object({
    id: moltbookIdSchema,
    post_id: moltbookIdSchema,
    parent_id: v.nullish(moltbookIdSchema, null),
    content: v.nullish(text(40_000), null),
    author: v.nullish(v.object({ name: text(128) })),
    created_at: v.optional(text(100)),
    is_deleted: v.nullish(v.boolean(), null),
    is_spam: v.nullish(v.boolean(), null),
    verification_status: v.nullish(text(64), null),
    replies: v.optional(v.array(v.unknown()), []),
});

/**
 * Project a bounded provider comment tree without recursively parsing provider-controlled nesting.
 * @param value - JSON already bounded by the provider transport's response budget.
 * @param input - Validated selected post, root sort and optional root continuation.
 * @returns Up to 100 passive excerpts with derived ancestry, separate root pagination and explicit local truncation.
 */
export function parseMoltbookComments(
    value: unknown,
    input: v.InferOutput<typeof moltbookCommentsInputSchema>
) {
    const page = v.parse(pageSchema, value);
    if (page.post_id !== input.id || page.sort !== input.sort)
        throw new Error("Moltbook returned a different comment selection.");
    if (page.has_more && (!page.next_cursor || page.next_cursor === input.cursor))
        throw new Error("Moltbook omitted a usable next comments cursor.");
    const comments = [] as {
        id: string;
        parentId: string | null;
        depth: number;
        excerpt: string | null;
        truncated: boolean | null;
        author: string | null;
        createdAt: string | null;
        deleted: boolean | null;
        spam: boolean | null;
        verificationStatus: string | null;
    }[];
    const stack = [
        { nodes: page.comments, index: 0, parentId: null as string | null, depth: 0 },
    ];
    const seen = new Set<string>();
    let truncated = false;
    while (stack.length > 0) {
        const frame = stack.at(-1)!;
        if (frame.index === frame.nodes.length) {
            stack.pop();
            continue;
        }
        if (comments.length === 100) {
            truncated = true;
            break;
        }
        const comment = v.parse(commentSchema, frame.nodes[frame.index++]);
        if (
            comment.post_id !== input.id ||
            comment.parent_id !== frame.parentId ||
            seen.has(comment.id)
        )
            throw new Error("Moltbook returned inconsistent comment ancestry.");
        seen.add(comment.id);
        comments.push({
            id: comment.id,
            parentId: frame.parentId,
            depth: frame.depth,
            excerpt: comment.is_deleted ? null : (comment.content?.slice(0, 800) ?? null),
            truncated:
                comment.is_deleted || comment.content === null
                    ? null
                    : comment.content.length > 800,
            author: comment.author?.name ?? null,
            createdAt: comment.created_at ?? null,
            deleted: comment.is_deleted,
            spam: comment.is_spam,
            verificationStatus: comment.verification_status,
        });
        if (comment.replies.length > 0) {
            if (frame.depth === 32) truncated = true;
            else
                stack.push({
                    nodes: comment.replies,
                    index: 0,
                    parentId: comment.id,
                    depth: frame.depth + 1,
                });
        }
    }
    return {
        postId: page.post_id,
        sort: page.sort,
        comments,
        rootsInPage: page.comments.length,
        nextCursor: page.has_more ? page.next_cursor : null,
        truncated,
    };
}
