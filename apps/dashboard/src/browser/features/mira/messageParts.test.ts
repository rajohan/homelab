import { expect, test } from "bun:test";

import type { MiraMessage } from "@homelab/contracts/mira";

import { chatMessageParts } from "./messageParts";

test("separate replies keep Markdown intact, interleave guidance and attach files only once", () => {
    const first = Bun.randomUUIDv7(),
        user = Bun.randomUUIDv7(),
        last = Bun.randomUUIDv7();
    const a = new Date().toISOString();
    const content = '🦊 I am checking.\n\n```json\n{"ok":true}\n```';
    const messages: MiraMessage[] = [
        {
            id: first,
            role: "assistant",
            content,
            state: "streaming",
            attachmentIds: ["file"],
            createdAt: a,
            parts: [
                { id: first, offset: 0, createdAt: a },
                { id: last, offset: 18, createdAt: a },
            ],
        },
        {
            id: user,
            role: "user",
            content: "Please continue",
            state: "completed",
            attachmentIds: [],
            createdAt: a,
        },
    ];
    const result = chatMessageParts(messages);
    expect(result.map((m) => m.id)).toEqual([first, user, last]);
    expect(result[0]).toMatchObject({
        content: "🦊 I am checking.",
        state: "completed",
        attachmentIds: [],
    });
    expect(result[2]).toMatchObject({
        content: '```json\n{"ok":true}\n```',
        state: "streaming",
        attachmentIds: ["file"],
    });
    expect(chatMessageParts([messages[1]!])).toEqual([messages[1]!]);
});
