import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { capabilities } from "@homelab/contracts/operations";
import {
    acknowledgeChatSteering,
    claimChatSteering,
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
            await f.client`UPDATE mira_messages SET state='interrupted' WHERE id=${f.run.userMessageId}`;
            await f.send("New explicit work.");
            const next = (await claimMiraRun(
                f.client,
                crypto.randomUUID(),
                "foreground"
            ))!;
            const restored = await readMiraTurnInput(f.client, next, true);
            expect(restored.content).not.toContain("A follow-up.");
            expect(restored.content).toContain("Start the task.");
            const retired = chat.messages.find((m) => m.content === "A follow-up.")!;
            await rejects(
                readMiraHistory(f.client, next, { messageId: retired.id, offset: 0 }),
                /not found/
            );
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
        await f.send("New explicit work.");
        const next = (await claimMiraRun(f.client, crypto.randomUUID(), "foreground"))!;
        const restored = await readMiraTurnInput(f.client, next, true);
        expect(restored.content).not.toContain("Do this once.");
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
            streaming.messages
                .filter((m) => m.role === "assistant")
                .map(({ id, content, state }) => ({ id, content, state }))
        ).toEqual([
            { id: parts[0]!.id, content: "Working.", state: "completed" },
            { id: parts[1]!.id, content: "Done.", state: "streaming" },
        ]);
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            text: "Working.\n\nDone.",
            parts,
            message: null,
        });
        expect(await saveMiraDelta(f.client, f.run, "Overwrite", [])).toBe(false);
        const completed = await f.api.conversations.read({ id: f.chat.id });
        expect(
            completed.messages
                .filter((m) => m.role === "assistant")
                .map(({ id, content, state }) => ({ id, content, state }))
        ).toEqual([
            { id: parts[0]!.id, content: "Working.", state: "completed" },
            { id: parts[1]!.id, content: "Done.", state: "completed" },
        ]);
    } finally {
        await f.close();
    }
});

test.each([
    ["failed", false],
    ["interrupted", false],
    ["failed", true],
    ["interrupted", true],
] as const)(
    "replies retain parent %s outcome unless explicitly completed: %s",
    async (state, confirmed) => {
        const f = await fixture();
        try {
            const parts = [
                {
                    id: f.run.assistantMessageId,
                    offset: 0,
                    completed: confirmed,
                    createdAt: new Date().toISOString(),
                },
                {
                    id: Bun.randomUUIDv7(),
                    offset: 14,
                    createdAt: new Date().toISOString(),
                },
            ];
            await finishMiraRun(f.client, f.run, {
                state,
                text: "First reply.\n\nLast reply.",
                parts,
                message: "Interrupted fixture",
            });
            // Exercise both persisted terminal message states, including rows retired by lease recovery.
            await f.client`UPDATE mira_messages SET state=${state} WHERE id=${f.run.assistantMessageId}`;
            const transcript = await f.api.conversations.read({ id: f.chat.id });
            expect(
                transcript.messages
                    .filter((row) => row.role === "assistant")
                    .map((row) => row.state)
            ).toEqual([confirmed ? "completed" : state, state]);
            await f.send("Continue explicitly.");
            const next = (await claimMiraRun(
                f.client,
                crypto.randomUUID(),
                "foreground"
            ))!;
            const history = await readMiraConversationHistory(f.client, next, {});
            expect(
                history.rows
                    .filter((row) => row.role === "assistant")
                    .map((row) => row.state)
            ).toEqual([state, confirmed ? "completed" : state]);
            const recovered = await readMiraTurnInput(f.client, next, true);
            expect(
                recovered.content.match(new RegExp(`"state":"${state}"`, "g"))
            ).toHaveLength(confirmed ? 1 : 2);
        } finally {
            await f.close();
        }
    }
);

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
            const replies = chat.messages.filter(
                (message) => message.role === "assistant"
            );
            const reply = replies.at(-1)!;
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
                expect(replies).toHaveLength(2);
                expect(reply.content).toBe(
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
        // One candidate per conversation: retire the missing file, then admit the next note.
        expect(await scheduleChatFollowups(f.client)).toBe(0);
        expect(await scheduleChatFollowups(f.client)).toBe(1);
        const chat = await f.api.conversations.read({ id: f.chat.id });
        expect(
            chat.messages.find((message) => message.content === "Read this file.")?.state
        ).toBe("interrupted");
        expect(
            chat.messages.filter((message) => message.content === "Then use this note.")
        ).toHaveLength(1);
        expect(chat.run?.state).toBe("queued");
        const next = (await claimMiraRun(f.client, crypto.randomUUID(), "foreground"))!;
        const restored = await readMiraTurnInput(f.client, next, true);
        expect(restored.content).not.toContain("Read this file.");
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

test.each([false, true])(
    "explicit Task Run waits for older chat guidance (attachment=%s)",
    async (attached) => {
        const f = await fixture();
        try {
            const task = Bun.randomUUIDv7();
            await f.client`INSERT INTO mira_tasks(id,owner,title,description,status,assignee,priority,completion_criteria,conversation_id) VALUES (${task},'operator','Fixture','Synthetic','in_progress','mira','normal','Verified',${f.chat.id})`;
            await f.client`UPDATE mira_runs SET task_id=${task} WHERE id=${f.run.id}`;
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
            const request = {
                id: task,
                version: 1,
                requestId: crypto.randomUUID(),
                instructions: "Newer task instructions",
            };
            await rejects(f.api.tasks.run(request), /earlier chat message/);
            expect(await scheduleChatFollowups(f.client)).toBe(1);
            const next = (await claimMiraRun(
                f.client,
                crypto.randomUUID(),
                "foreground"
            ))!;
            const input = await readMiraTurnInput(f.client, next);
            expect(input.content).toEndWith("Older guidance");
            expect(input.content).not.toContain("Newer task instructions");
            expect(input.attachmentIds).toEqual(attached ? [file] : []);
            await finishMiraRun(f.client, next, {
                state: "completed",
                text: "Handled older guidance",
                message: null,
            });
            const started = await f.api.tasks.run(request);
            const last = (await claimMiraRun(
                f.client,
                crypto.randomUUID(),
                "foreground"
            ))!;
            expect(last.id).toBe(started.id);
            const finalInput = await readMiraTurnInput(f.client, last);
            expect(finalInput.content).toContain("Newer task instructions");
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
            // oxlint-disable-next-line typescript/no-misused-spread -- Persisted offsets are Unicode code points.
            offset: [...first].length + 2,
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
        expect(full.content).toBe(second);
        expect(full.context.map((row) => row.excerpt)).toEqual([
            first,
            "Change of plan.",
        ]);
    } finally {
        await f.close();
    }
});

test.each(["done", "blocked", "reassigned", "deleted"])(
    "follow-ups retire when linked task becomes %s",
    async (change) => {
        const f = await fixture();
        try {
            const task = Bun.randomUUIDv7();
            await f.client`INSERT INTO mira_tasks(id,owner,title,description,status,assignee,priority,completion_criteria,conversation_id) VALUES (${task},'operator','Fixture','Synthetic','in_progress','mira','normal','Verified',${f.chat.id})`;
            await f.client`UPDATE mira_runs SET task_id=${task} WHERE id=${f.run.id}`;
            await f.send("Pending task guidance");
            await finishMiraRun(f.client, f.run, {
                state: "completed",
                text: "Finished turn",
                message: null,
            });
            await f.client`UPDATE mira_tasks SET status=${change === "done" || change === "blocked" ? change : "in_progress"},assignee=${change === "reassigned" ? "operator" : "mira"},deleted_at=${change === "deleted" ? new Date() : null} WHERE id=${task}`;
            expect(await scheduleChatFollowups(f.client)).toBe(0);
            const chat = await f.api.conversations.read({ id: f.chat.id });
            expect(
                chat.messages.find(
                    (message) => message.content === "Pending task guidance"
                )?.state
            ).toBe("interrupted");
            await f.client`UPDATE mira_tasks SET status='in_progress',assignee='mira',deleted_at=NULL WHERE id=${task}`;
            await f.send("New explicit request");
            const next = (await claimMiraRun(
                f.client,
                crypto.randomUUID(),
                "foreground"
            ))!;
            expect(await claimChatSteering(f.client, next)).toBeNull();
            const restored = await readMiraTurnInput(f.client, next, true);
            expect(restored.content).not.toContain("Pending task guidance");
        } finally {
            await f.close();
        }
    }
);

test("temporarily full owners cannot starve later conversations", async () => {
    const f = await fixture();
    try {
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            text: "Done",
            message: null,
        });
        const other = appRouter.createCaller({
            operations: f,
            principal: { kind: "human", id: "other", capabilities },
        }).mira;
        for (let index = 0; index < 21; index++) {
            const api = index < 20 ? f.api : other;
            const chat = await api.conversations.create({ title: `Pending ${index}` });
            await api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Start",
            });
            const run = (await claimMiraRun(
                f.client,
                crypto.randomUUID(),
                "foreground"
            ))!;
            await api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Follow up",
            });
            await finishMiraRun(f.client, run, {
                state: "completed",
                text: "Done",
                message: null,
            });
        }
        for (let index = 0; index < 32; index++) {
            const chat = await f.api.conversations.create({ title: `Occupy ${index}` });
            await f.api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Queued work",
            });
        }
        expect(await scheduleChatFollowups(f.client)).toBe(0);
        expect(await scheduleChatFollowups(f.client)).toBe(1);
        const [deferred] = await f.client<
            { total: number }[]
        >`SELECT count(*)::int AS total FROM mira_chat_inputs WHERE owner='operator' AND state='pending' AND next_attempt_at>clock_timestamp()`;
        expect(deferred?.total).toBe(20);
    } finally {
        await f.close();
    }
}, 15_000);

test("history search applies before pagination to each Unicode reply", async () => {
    const f = await fixture();
    try {
        const parts = [];
        let content = "";
        for (let index = 0; index < 12; index++) {
            parts.push({
                id: Bun.randomUUIDv7(),
                // oxlint-disable-next-line typescript/no-misused-spread -- Persisted offsets are Unicode code points.
                offset: [...content].length,
                createdAt: new Date().toISOString(),
            });
            content +=
                (index === 0
                    ? "🦊 Fjordplan decision."
                    : `🦊 Unrelated reply ${index}.`) + "\n\n";
        }
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            text: content,
            parts,
            message: null,
        });
        await f.send("Find the decision");
        const next = (await claimMiraRun(f.client, crypto.randomUUID(), "foreground"))!;
        const result = await readMiraConversationHistory(f.client, next, {
            query: "fjordplan",
        });
        expect(result.rows.map((row) => row.excerpt)).toEqual(["🦊 Fjordplan decision."]);
        expect(result.nextBeforeMessageId).toBeNull();
    } finally {
        await f.close();
    }
});

test("transcript pages keep every reply interleaved with guidance beyond fifty rows", async () => {
    const f = await fixture();
    try {
        const first = await f.api.conversations.read({ id: f.chat.id });
        const expected = [first.messages.find((m) => m.role === "user")!.id];
        const parts = [];
        let content = "";
        let offset = 0;
        for (let index = 0; index < 55; index++) {
            if (index > 0) {
                await f.send(`Guidance ${index}.`);
                const input = (await claimChatSteering(f.client, f.run))!;
                await acknowledgeChatSteering(f.client, f.run, input.id, true);
                expected.push(input.id);
            }
            const id = Bun.randomUUIDv7();
            parts.push({ id, offset, createdAt: new Date().toISOString() });
            expected.push(id);
            const reply = `Reply ${index}.\n\n`;
            content += reply;
            offset += reply.length;
        }
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            text: content,
            parts,
            message: null,
        });
        let page = await f.api.conversations.read({ id: f.chat.id });
        expect(page.messages).toHaveLength(50);
        expect(page.messages.at(-1)?.content).toBe("Reply 54.");
        const all = [...page.messages];
        for (let count = 0; page.nextCursor && count < 4; count++) {
            page = await f.api.conversations.read({
                id: f.chat.id,
                before: page.nextCursor,
            });
            all.unshift(...page.messages);
        }
        expect(page.nextCursor).toBeNull();
        expect(all.map((message) => message.id)).toEqual(expected);
        expect(new Set(all.map((message) => message.id)).size).toBe(expected.length);
        expect(
            all
                .filter((message) => message.role === "assistant")
                .every((message) => message.state === "completed")
        ).toBe(true);
    } finally {
        await f.close();
    }
});
