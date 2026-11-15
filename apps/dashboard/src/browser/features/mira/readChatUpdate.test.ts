import { expect, test } from "bun:test";

import type { MiraMessage } from "@homelab/contracts/mira";

import { readChatUpdate } from "./readChatUpdate";

type Page = Awaited<ReturnType<typeof readChatUpdate>>;
const message = (id: string, content = id): MiraMessage => ({
    id,
    content,
    role: "assistant",
    state: "completed",
    attachmentIds: [],
    createdAt: new Date().toISOString(),
});
const page = (messages: MiraMessage[], nextCursor: string | null): Page => ({
    conversation: {
        id: "conversation",
        title: "Chat",
        version: 1,
        archivedAt: null,
        createdAt: "",
        updatedAt: "",
        settings: {
            model: null,
            effort: null,
            serviceTier: null,
            useMemory: true,
            useHistory: true,
            executionTarget: "main",
            permissionMode: "ask",
        },
    },
    messages,
    nextCursor,
    run: null,
    tools: [],
});

test("live refresh catches up across missed pages and keeps history anchored without repolling it", async () => {
    const previous = page([message("20"), message("30", "Streaming")], "20");
    const calls: (string | undefined)[] = [];
    const result = await readChatUpdate(
        "conversation",
        previous,
        new AbortController().signal,
        (input) => {
            calls.push(input.before);
            if (input.before === undefined)
                return Promise.resolve(page([message("70"), message("80")], "70"));
            if (input.before === "70")
                return Promise.resolve(page([message("50"), message("60")], "50"));
            return Promise.resolve(
                page([message("30", "Finished"), message("40")], "30")
            );
        }
    );
    expect(calls).toEqual([undefined, "70", "50"]);
    expect(result.messages.map((m) => m.id)).toEqual([
        "20",
        "30",
        "40",
        "50",
        "60",
        "70",
        "80",
    ]);
    expect(result.messages[1]?.content).toBe("Finished");
    expect(result.nextCursor).toBe("20");
    calls.length = 0;
    const next = await readChatUpdate(
        "conversation",
        result,
        new AbortController().signal,
        (input) => {
            calls.push(input.before);
            return Promise.resolve(page([message("80"), message("90")], "80"));
        }
    );
    expect(calls).toEqual([undefined]);
    expect(next.messages.map((m) => m.id)).toEqual([
        "20",
        "30",
        "40",
        "50",
        "60",
        "70",
        "80",
        "90",
    ]);
});

test("initial loads stay bounded, and cancellation interrupts reconnect catch-up", async () => {
    const latest = page([message("70"), message("80")], "70");
    expect(
        await readChatUpdate(
            "conversation",
            undefined,
            new AbortController().signal,
            () => Promise.resolve(latest)
        )
    ).toBe(latest);
    const controller = new AbortController();
    await expect(
        readChatUpdate("conversation", page([], null), controller.signal, () => {
            controller.abort();
            return Promise.resolve(latest);
        })
    ).rejects.toThrow();
});
