import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

/** Encoded visual history is bounded independently of the model's token window. */
export const visualContextBytes = 8 * 1024 * 1024;
/** Bound screenshot count even when the individual frames compress extremely well. */
export const visualContextImages = 12;
const recordSchema = v.object({
    type: v.string(),
    payload: v.record(v.string(), v.unknown()),
});
const itemSchema = v.objectWithRest({ type: v.string() }, v.unknown());
type Item = v.InferOutput<typeof itemSchema>;

/**
 * Count inline images without exposing their content or charging encoded bytes as text tokens.
 * @param value - A provider history item or host tool result.
 * @returns Inline image count and UTF-8 transport bytes.
 */
export function inlineImages(value: unknown): { count: number; bytes: number } {
    if (typeof value === "string") {
        const matches = [
            ...value.matchAll(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{32,}/gi),
        ];
        return {
            count: matches.length,
            bytes: matches.reduce(
                (total, match) => total + Buffer.byteLength(match[0]),
                0
            ),
        };
    }
    const total = { count: 0, bytes: 0 };
    if (value && typeof value === "object")
        for (const child of Object.values(value)) {
            const current = inlineImages(child);
            total.count += current.count;
            total.bytes += current.bytes;
        }
    return total;
}

/**
 * Withdraw expired image copies while preserving text and opaque native compaction items.
 * @param value - Provider history copied into a new, uncommitted context.
 * @returns The same non-image values, with explicit text markers instead of image pixels.
 */
export function withoutHistoricalImages(value: unknown): unknown {
    if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        "type" in value &&
        value.type === "input_image"
    )
        return {
            type: "input_text",
            text: "[Historical screenshot expired. Retain the surrounding observations and task context; use a fresh observation for current screen state.]",
        };
    if (typeof value === "string")
        return value.replaceAll(
            /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{32,}/gi,
            "[historical screenshot expired]"
        );
    if (Array.isArray(value)) return value.map((child) => withoutHistoricalImages(child));
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
                key,
                withoutHistoricalImages(child),
            ])
        );
    return value;
}

async function checkedFile(home: string, threadId: string, filename: string) {
    if (
        !/^[0-9a-f-]{36}$/.test(threadId) ||
        !path.isAbsolute(filename) ||
        !filename.endsWith(`-${threadId}.jsonl`)
    )
        throw new Error("Unsupported provider history location.");
    const root = await realpath(home);
    const canonical = await realpath(filename);
    const relative = path.relative(root, canonical);
    if (
        path.isAbsolute(relative) ||
        relative.startsWith(`..${path.sep}`) ||
        !["sessions", "archived_sessions"].includes(relative.split(path.sep)[0] ?? "")
    )
        throw new Error("Provider history is outside Mira's private storage.");
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error("Provider history must be a regular owned file.");
    return { canonical, entry };
}

async function* records(filename: string, start = 0) {
    const stream = createReadStream(filename, { start });
    let offset = start;
    let pending = Buffer.alloc(0);
    try {
        for await (const chunk of stream) {
            pending = Buffer.concat([pending, Buffer.from(chunk)]);
            let end: number;
            while ((end = pending.indexOf(10)) !== -1) {
                if (end > 32 * 1024 * 1024)
                    throw new Error("Provider history record exceeds its limit.");
                const record = v.parse(
                    recordSchema,
                    JSON.parse(pending.subarray(0, end).toString("utf8"))
                );
                yield { record, offset };
                offset += end + 1;
                pending = pending.subarray(end + 1);
            }
            if (pending.length > 32 * 1024 * 1024)
                throw new Error("Provider history record exceeds its limit.");
        }
        if (pending.length > 0)
            throw new Error("Provider history contains an incomplete record.");
    } finally {
        stream.destroy();
    }
}

/** A read-only snapshot of the pinned Codex legacy history contract; no provider files are edited. */
export interface RolloutContext {
    filename: string;
    threadId: string;
    size: number;
    modified: number;
    checkpointOffset: number;
    images: number;
    imageBytes: number;
}

/**
 * Inspect the latest native checkpoint plus subsequent items, ignoring obsolete visual history.
 * @param home - Isolated Codex home from trusted runtime configuration.
 * @param threadId - Provider reference already bound to the owned conversation.
 * @param filename - Location returned by that provider's thread/read response.
 * @returns Bounded metadata; only batch iteration reads the actual context.
 */
export async function inspectRolloutContext(
    home: string,
    threadId: string,
    filename: string
): Promise<RolloutContext> {
    const { canonical, entry } = await checkedFile(home, threadId, filename);
    let checkpointOffset = 0,
        images = 0,
        imageBytes = 0,
        first = true;
    for await (const { record, offset } of records(canonical)) {
        if (first) {
            if (record.type !== "session_meta" || record.payload.id !== threadId)
                throw new Error(
                    "Provider history identity differs from its conversation."
                );
            first = false;
        }
        if (record.type === "compacted") {
            v.parse(v.array(itemSchema), record.payload.replacement_history);
            checkpointOffset = offset;
            images = 0;
            imageBytes = 0;
        }
        if (record.type === "response_item" || record.type === "compacted") {
            const count = inlineImages(
                record.type === "compacted"
                    ? record.payload.replacement_history
                    : record.payload
            );
            images += count.count;
            imageBytes += count.bytes;
        }
    }
    if (first) throw new Error("Provider history is empty.");
    const after = await lstat(canonical);
    if (after.size !== entry.size || after.mtimeMs !== entry.mtimeMs)
        throw new Error("Provider history changed during inspection.");
    return {
        filename: canonical,
        threadId,
        size: entry.size,
        modified: entry.mtimeMs,
        checkpointOffset,
        images,
        imageBytes,
    };
}

/**
 * Replay native context in small complete tool exchanges for the provider's own compactor.
 * @param context - Previously inspected immutable source; the original is retained on failure.
 * @param expireImages - Withdraw image copies while retaining their surrounding observations.
 * @yields {Item[]} Original items in order, including opaque native compaction state without modification.
 */
export async function* rolloutContextBatches(
    context: RolloutContext,
    expireImages = false
): AsyncGenerator<Item[]> {
    const before = await lstat(context.filename);
    if (before.size !== context.size || before.mtimeMs !== context.modified)
        throw new Error("Provider history changed before recovery.");
    let batch: Item[] = [],
        bytes = 0;
    const pending = new Set<string>();
    for await (const { record } of records(context.filename, context.checkpointOffset)) {
        let items: Item[] = [];
        if (record.type === "compacted")
            items = v.parse(v.array(itemSchema), record.payload.replacement_history);
        else if (record.type === "response_item")
            items = [v.parse(itemSchema, record.payload)];
        for (const source of items) {
            const item = expireImages
                ? v.parse(itemSchema, withoutHistoricalImages(source))
                : source;
            batch.push(item);
            bytes += Buffer.byteLength(JSON.stringify(item));
            if (
                (item.type === "function_call" || item.type === "custom_tool_call") &&
                typeof item.call_id === "string"
            )
                pending.add(item.call_id);
            if (
                (item.type === "function_call_output" ||
                    item.type === "custom_tool_call_output") &&
                typeof item.call_id === "string"
            )
                pending.delete(item.call_id);
            if (
                bytes >= (expireImages ? 256 * 1024 : visualContextBytes) &&
                pending.size === 0
            ) {
                yield batch;
                batch = [];
                bytes = 0;
            }
            if (bytes > 32 * 1024 * 1024)
                throw new Error("A provider tool exchange exceeds the recovery limit.");
        }
    }
    const after = await lstat(context.filename);
    if (after.size !== context.size || after.mtimeMs !== context.modified)
        throw new Error("Provider history changed during recovery.");
    if (pending.size > 0)
        throw new Error(
            "Provider history contains an unfinished tool exchange; review its outcome before recovery."
        );
    if (batch.length > 0) yield batch;
}
