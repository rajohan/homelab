import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    inlineImages,
    inspectRolloutContext,
    rolloutContextBatches,
    withoutHistoricalImages,
} from "./rolloutContext";

const threadId = "00000000-0000-4000-8000-000000000001";
const image = `data:image/png;base64,${"A".repeat(128)}`;
const frame = { type: "input_image", image_url: image };
const text = {
    type: "message",
    role: "user",
    content: [
        { type: "input_text", text: "Keep the goal and the operator's correction: blå." },
    ],
};
const checkpoint = {
    type: "compaction",
    encrypted_content: "opaque-native-state-must-remain-identical",
};
const record = (type: string, payload: object) =>
    JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type, payload });

async function fixture(run: (home: string, filename: string) => Promise<void>) {
    const home = await mkdtemp(path.join(tmpdir(), "mira-context-"));
    await mkdir(path.join(home, "sessions"));
    const filename = path.join(home, "sessions", `rollout-${threadId}.jsonl`);
    try {
        await run(home, filename);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
}

test("reads only the latest native context while preserving all current text and opaque state", async () => {
    await fixture(async (home, filename) => {
        await writeFile(
            filename,
            [
                record("session_meta", { id: threadId }),
                record("response_item", {
                    type: "message",
                    role: "user",
                    content: [frame, frame],
                }),
                record("compacted", { replacement_history: [text, checkpoint] }),
                record("event_msg", { content: [frame, frame, frame] }),
                record("response_item", {
                    type: "custom_tool_call",
                    call_id: "observe",
                    name: "exec",
                    input: "observe()",
                }),
                record("response_item", {
                    type: "custom_tool_call_output",
                    call_id: "observe",
                    output: [
                        {
                            type: "input_text",
                            text: "Observed score: 2–1; next action remains unconfirmed.",
                        },
                        frame,
                    ],
                }),
            ].join("\n") + "\n"
        );
        const context = await inspectRolloutContext(home, threadId, filename);
        expect(context.images).toBe(1);
        expect(context.imageBytes).toBe(image.length);
        const batches = await Array.fromAsync(rolloutContextBatches(context, true));
        const items = batches.flat();
        expect(items.slice(0, 2)).toEqual([text, checkpoint]);
        expect(inlineImages(items).count).toBe(0);
        expect(JSON.stringify(items)).toContain(
            "Observed score: 2–1; next action remains unconfirmed."
        );
        expect(JSON.stringify(items)).toContain("Historical screenshot expired");
        expect(await Bun.file(filename).text()).toContain(image);
    });
});

test("never compacts through an outstanding tool call or silently accepts changed source", async () => {
    await fixture(async (home, filename) => {
        await writeFile(
            filename,
            [
                record("session_meta", { id: threadId }),
                record("response_item", {
                    type: "function_call",
                    call_id: "pending",
                    name: "write",
                    arguments: "{}",
                }),
            ].join("\n") + "\n"
        );
        const context = await inspectRolloutContext(home, threadId, filename);
        await expect(
            Array.fromAsync(rolloutContextBatches(context, true))
        ).rejects.toThrow("unfinished tool exchange");
        await writeFile(filename, "changed\n");
        await expect(Array.fromAsync(rolloutContextBatches(context))).rejects.toThrow(
            "changed before recovery"
        );
    });
});

test("rejects another conversation, traversal and unsupported checkpoint formats", async () => {
    await fixture(async (home, filename) => {
        await writeFile(
            filename,
            record("session_meta", { id: "another-thread" }) + "\n"
        );
        await expect(inspectRolloutContext(home, threadId, filename)).rejects.toThrow(
            "identity"
        );
        await expect(inspectRolloutContext(home, "../escape", filename)).rejects.toThrow(
            "location"
        );
        await expect(
            inspectRolloutContext(path.join(home, "sessions"), threadId, filename)
        ).rejects.toThrow("outside");
        await writeFile(
            filename,
            [
                record("session_meta", { id: threadId }),
                record("compacted", {
                    message: "legacy summary without a reusable checkpoint",
                }),
            ].join("\n") + "\n"
        );
        await expect(inspectRolloutContext(home, threadId, filename)).rejects.toThrow();
    });
});

test("withdraws image copies embedded in tool text without changing other strings or native state", () => {
    const input = {
        array: [null, false, text, checkpoint, frame],
        output: `Observation metadata ${image} and its recorded result.`,
    };
    expect(inlineImages(input).count).toBe(2);
    const cleaned = withoutHistoricalImages(input);
    expect(inlineImages(cleaned).count).toBe(0);
    expect(JSON.stringify(cleaned)).toContain(checkpoint.encrypted_content);
    expect(JSON.stringify(cleaned)).toContain("and its recorded result.");
    expect(JSON.stringify(input)).toContain(image);
});
