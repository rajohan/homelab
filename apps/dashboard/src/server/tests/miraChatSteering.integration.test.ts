import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { capabilities } from "@homelab/contracts/operations";
import {
    claimChatSteering,
    acknowledgeChatSteering,
    scheduleChatFollowups,
} from "@homelab/mira/data/chatSteering";
import { claimMiraRun, finishMiraRun, saveMiraDelta } from "@homelab/mira/data/queue";
import { readMiraConversationHistory, readMiraHistory } from "@homelab/mira/data/recall";

import { readMiraTurnInput } from "../../../../mira/src/server/executor/context";
import { executeMiraTurn } from "../../../../mira/src/server/executor/turn";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

async function fixture() {
    const db = await operationFixture();
    const principal = { kind: "human" as const, id: "operator", capabilities };
    const api = appRouter.createCaller({ operations: db, principal }).mira;
    const chat = await api.conversations.create({ title: "Steering fixture" });
    await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Start the task.",
    });
    const run = await claimMiraRun(db.client, crypto.randomUUID(), "foreground");
    if (!run) throw new Error("Missing test run");
    return {
        ...db,
        api,
        chat,
        run,
        send: (text: string) =>
            api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text,
            }),
    };
}

test("guidance is durable, owned, idempotent and acknowledged by the current lease", async () => {
    const f = await fixture();
    try {
        const input = {
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Use the updated plan.",
        };
        expect(await f.api.conversations.send(input)).toEqual({ id: f.run.id });
        expect(await f.api.conversations.send(input)).toEqual({ id: f.run.id });
        await rejects(
            f.api.conversations.send({ ...input, text: "Different message" }),
            /already belongs/
        );
        expect(
            await claimChatSteering(f.client, { ...f.run, owner: "foreign" })
        ).toBeNull();
        expect(
            await claimChatSteering(f.client, {
                ...f.run,
                leaseToken: crypto.randomUUID(),
            })
        ).toBeNull();
        const guidance = await claimChatSteering(f.client, f.run);
        expect(guidance?.content).toBe(input.text);
        expect(await claimChatSteering(f.client, f.run)).toBeNull();
        expect(
            await acknowledgeChatSteering(
                f.client,
                { ...f.run, leaseToken: crypto.randomUUID() },
                guidance!.id,
                true
            )
        ).toBe(false);
        expect(await acknowledgeChatSteering(f.client, f.run, guidance!.id, true)).toBe(
            true
        );
        const chat = await f.api.conversations.read({ id: f.chat.id });
        expect(chat.messages.filter((m) => m.content === input.text)).toHaveLength(1);
        expect(chat.messages.find((m) => m.id === guidance!.id)?.state).toBe("completed");
        expect(await scheduleChatFollowups(f.client)).toBe(0);
    } finally {
        await f.close();
    }
});

test("guidance that misses turn completion continues once without a duplicate user bubble", async () => {
    const f = await fixture();
    try {
        await f.send("Continue with this correction.");
        const guidance = await claimChatSteering(f.client, f.run);
        await acknowledgeChatSteering(f.client, f.run, guidance!.id, false);
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            text: "First answer",
            message: null,
        });
        expect(await scheduleChatFollowups(f.client)).toBe(1);
        expect(await scheduleChatFollowups(f.client)).toBe(0);
        const next = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(next?.userMessageId).toBe(guidance!.id);
        const chat = await f.api.conversations.read({ id: f.chat.id });
        expect(
            chat.messages.filter((m) => m.content === "Continue with this correction.")
        ).toHaveLength(1);
        expect(chat.run?.id).toBe(next?.id);
    } finally {
        await f.close();
    }
});

test.each(["interrupted", "needs_attention", "failed"] as const)(
    "pending guidance does not restart %s work",
    async (state) => {
        const f = await fixture();
        try {
            await f.send("A follow-up.");
            await finishMiraRun(f.client, f.run, {
                state,
                text: "Stopped",
                message: null,
            });
            expect(await scheduleChatFollowups(f.client)).toBe(0);
            const chat = await f.api.conversations.read({ id: f.chat.id });
            expect(chat.messages.find((m) => m.content === "A follow-up.")?.state).toBe(
                "interrupted"
            );
            expect(
                await claimMiraRun(f.client, crypto.randomUUID(), "foreground")
            ).toBeNull();
        } finally {
            await f.close();
        }
    }
);

test("unacknowledged guidance is not replayed after provider or executor loss", async () => {
    const f = await fixture();
    try {
        await f.send("Do this once.");
        await claimChatSteering(f.client, f.run);
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            text: "Reply",
            message: null,
        });
        expect(await scheduleChatFollowups(f.client)).toBe(0);
        const chat = await f.api.conversations.read({ id: f.chat.id });
        expect(chat.messages.find((m) => m.content === "Do this once.")?.state).toBe(
            "interrupted"
        );
    } finally {
        await f.close();
    }
});

test("reply boundaries survive polling and completion and stale leases cannot rewrite them", async () => {
    const f = await fixture();
    try {
        const parts = [
            {
                id: f.run.assistantMessageId,
                offset: 0,
                createdAt: new Date().toISOString(),
            },
            { id: Bun.randomUUIDv7(), offset: 10, createdAt: new Date().toISOString() },
        ];
        await saveMiraDelta(f.client, f.run, "Working.\n\nDone.", parts);
        const streaming = await f.api.conversations.read({ id: f.chat.id });
        expect(
            streaming.messages.find((m) => m.id === f.run.assistantMessageId)?.parts
        ).toEqual(parts);
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            text: "Working.\n\nDone.",
            parts,
            message: null,
        });
        expect(await saveMiraDelta(f.client, f.run, "Overwrite", [])).toBe(false);
        const completed = await f.api.conversations.read({ id: f.chat.id });
        expect(
            completed.messages.find((m) => m.id === f.run.assistantMessageId)?.parts
        ).toEqual(parts);
    } finally {
        await f.close();
    }
});

test.each(["steer-ok", "steer-error", "message-boundaries"])(
    "the executor persists real provider replies and guidance: %s",
    async (mode) => {
        const f = await fixture();
        const directory = await mkdtemp(path.join(tmpdir(), "mira-chat-steering-"));
        const stop = new AbortController();
        let execution: Promise<void> | undefined;
        try {
            const command = path.join(directory, "synthetic-codex");
            const home = path.join(directory, "home"),
                workspace = path.join(directory, "workspace");
            await mkdir(home);
            await mkdir(workspace);
            const child = fileURLToPath(
                new URL(
                    "../../../../mira/src/server/testing/runtimeChild.ts",
                    import.meta.url
                )
            );
            await writeFile(
                command,
                `#!/usr/bin/env bun\nprocess.argv=[process.argv[0],${JSON.stringify(child)},${JSON.stringify(mode)},${JSON.stringify(home)}];\nawait import(${JSON.stringify(child)});\n`
            );
            await chmod(command, 0o700);
            execution = executeMiraTurn(
                f.client,
                { command, codexHome: home, workspace, model: "synthetic" },
                f.run,
                stop.signal
            );
            if (mode.startsWith("steer-")) {
                let started = false;
                for (let attempt = 0; attempt < 200 && !started; attempt++) {
                    const [row] = await f.client<
                        { started: boolean }[]
                    >`SELECT provider_turn IS NOT NULL AS started FROM mira_runs WHERE id=${f.run.id}`;
                    started = row?.started === true;
                    if (!started) await delay(10);
                }
                expect(started).toBe(true);
                await f.send("Use the changed instructions.");
            }
            await execution;
            const chat = await f.api.conversations.read({ id: f.chat.id });
            const reply = chat.messages.find(
                (message) => message.id === f.run.assistantMessageId
            )!;
            expect(chat.run?.state).toBe(
                mode === "steer-error" ? "needs_attention" : "completed"
            );
            if (mode === "steer-ok") {
                expect(reply.content).toContain("Use the changed instructions.");
                expect(
                    chat.messages.find(
                        (message) => message.content === "Use the changed instructions."
                    )?.state
                ).toBe("completed");
            }
            if (mode === "message-boundaries") {
                expect(reply.parts).toHaveLength(2);
                expect(reply.content.slice(reply.parts![1]!.offset)).toBe(
                    'Created.\n\n```json\n{\n  "ok": true\n}\n```'
                );
            }
            expect(await scheduleChatFollowups(f.client)).toBe(0);
        } finally {
            stop.abort();
            await Promise.allSettled([execution]);
            await f.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
    15_000
);

test("files sent during work wait for the next turn and a deleted file cannot strand the queue", async () => {
    const f = await fixture();
    try {
        const file = crypto.randomUUID();
        await f.client`INSERT INTO mira_attachments(id,owner,name,media_type,bytes,sha256,ready_at) VALUES (${file},'operator','fixture.txt','text/plain',8,${"a".repeat(64)},now())`;
        await f.api.conversations.send({
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Read this file.",
            attachmentIds: [file],
        });
        await f.send("Then use this note.");
        expect(await claimChatSteering(f.client, f.run)).toBeNull();
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            text: "First answer",
            message: null,
        });
        await f.client`UPDATE mira_attachments SET deleted_at=now() WHERE id=${file}`;
        expect(await scheduleChatFollowups(f.client)).toBe(1);
        const chat = await f.api.conversations.read({ id: f.chat.id });
        expect(
            chat.messages.find((message) => message.content === "Read this file.")?.state
        ).toBe("interrupted");
        expect(
            chat.messages.filter((message) => message.content === "Then use this note.")
        ).toHaveLength(1);
        expect(chat.run?.state).toBe("queued");
    } finally {
        await f.close();
    }
});

test("stopping a run and archiving a conversation prevent pending guidance from restarting it", async () => {
    const f = await fixture();
    try {
        await f.send("Do not lose this queued note.");
        await f.api.runs.cancel({ id: f.run.id });
        await rejects(f.send("Too late"), /stopped/);
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            text: "Already finishing",
            message: null,
        });
        expect(await scheduleChatFollowups(f.client)).toBe(0);
        const chat = await f.api.conversations.read({ id: f.chat.id });
        expect(
            chat.messages.find(
                (message) => message.content === "Do not lose this queued note."
            )?.state
        ).toBe("interrupted");
        await f.api.conversations.change({
            id: f.chat.id,
            version: chat.conversation.version,
            action: "archive",
        });
        await rejects(f.send("After archive"), /active conversation/);
    } finally {
        await f.close();
    }
});

test.each([false, true])(
    "a fresh send queues older pending guidance first (attachment=%s)",
    async (attached) => {
        const f = await fixture();
        try {
            const file = crypto.randomUUID();
            if (attached)
                await f.client`INSERT INTO mira_attachments(id,owner,name,media_type,bytes,sha256,ready_at) VALUES (${file},'operator','older.txt','text/plain',8,${"a".repeat(64)},now())`;
            await f.api.conversations.send({
                conversationId: f.chat.id,
                requestId: crypto.randomUUID(),
                text: "Older guidance",
                attachmentIds: attached ? [file] : [],
            });
            await finishMiraRun(f.client, f.run, {
                state: "completed",
                text: "First reply",
                message: null,
            });
            const fresh = {
                conversationId: f.chat.id,
                requestId: crypto.randomUUID(),
                text: "Newer guidance",
            };
            const sent = await f.api.conversations.send(fresh);
            expect(await f.api.conversations.send(fresh)).toEqual(sent);
            expect(await scheduleChatFollowups(f.client)).toBe(0);
            const next = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
            expect(next?.id).toBe(sent.id);
            const input = await readMiraTurnInput(f.client, next!);
            expect(input.content).toEndWith("Older guidance");
            expect(input.content).not.toContain("Newer guidance");
            expect(input.attachmentIds).toEqual(attached ? [file] : []);
            expect(await claimChatSteering(f.client, next!)).toMatchObject({
                content: "Newer guidance",
            });
        } finally {
            await f.close();
        }
    }
);

test("recovery and paged retrieval interleave reply parts with acknowledged guidance", async () => {
    const f = await fixture();
    try {
        const first = "🦊 First answer.";
        const second = "🦊 Answer after guidance.";
        const parts = [
            { id: Bun.randomUUIDv7(), offset: 0, createdAt: new Date().toISOString() },
        ];
        await f.send("Change of plan.");
        const guidance = (await claimChatSteering(f.client, f.run))!;
        await acknowledgeChatSteering(f.client, f.run, guidance.id, true);
        parts.push({
            id: Bun.randomUUIDv7(),
            offset: first.length + 2,
            createdAt: new Date().toISOString(),
        });
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            text: `${first}\n\n${second}`,
            parts,
            message: null,
        });
        await f.send("Continue here.");
        const next = (await claimMiraRun(f.client, crypto.randomUUID(), "foreground"))!;
        const restored = await readMiraTurnInput(f.client, next, true);
        expect(restored.content.indexOf(first)).toBeLessThan(
            restored.content.indexOf("Change of plan.")
        );
        expect(restored.content.indexOf("Change of plan.")).toBeLessThan(
            restored.content.indexOf(second)
        );
        const page = await readMiraConversationHistory(f.client, next, {});
        expect(page.rows.slice(0, 3).map((row) => row.excerpt)).toEqual([
            second,
            "Change of plan.",
            first,
        ]);
        const older = await readMiraConversationHistory(f.client, next, {
            beforeMessageId: parts[1]!.id,
        });
        expect(older.rows.slice(0, 2).map((row) => row.excerpt)).toEqual([
            "Change of plan.",
            first,
        ]);
        const full = await readMiraHistory(f.client, next, {
            messageId: page.rows[0]!.messageId,
            offset: 0,
        });
        expect(full.parts).toEqual(parts);
        expect(full.content).toBe(`${first}\n\n${second}`);
    } finally {
        await f.close();
    }
});
