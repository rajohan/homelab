import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { capabilities } from "@homelab/contracts/operations";
import { miraQueueAvailable } from "@homelab/mira/data/capacity";
import { cleanupMiraFiles, readMiraFile, saveMiraFile } from "@homelab/mira/data/files";
import { claimMiraRun, finishMiraRun } from "@homelab/mira/data/queue";

import {
    cleanupMiraConversations,
    cleanupMiraResources,
} from "../../../../mira/src/server/executor/cleanup";
import { readMiraTurnInput } from "../../../../mira/src/server/executor/context";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

test("Mira file recovery retries pending writes and purges only durable expired or deleted records", async () => {
    const fixture = await operationFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-recovery-"));
    const context = {
        client: fixture.client,
        owner: "operator",
        actor: "human:operator",
    };
    const input = {
        id: crypto.randomUUID(),
        name: "synthetic.txt",
        bytes: new TextEncoder().encode("Synthetic recovery"),
    };
    try {
        const digest = new Bun.CryptoHasher("sha256").update(input.bytes).digest("hex");
        await fixture.client`INSERT INTO mira_attachments (id, owner, name, media_type, bytes, sha256) VALUES (${input.id}, 'operator', ${input.name}, 'text/plain; charset=utf-8', ${input.bytes.length}, ${digest})`;
        await writeFile(path.join(directory, input.id), "partial");
        await rejects(readMiraFile(context, directory, input.id), /not found/);
        await saveMiraFile(context, directory, input);
        const read = await readMiraFile(context, directory, input.id);
        expect(Buffer.from(read.bytes)).toEqual(Buffer.from(input.bytes));
        const unfinished = crypto.randomUUID();
        await fixture.client`INSERT INTO mira_attachments (id, owner, name, media_type, bytes, sha256, created_at) VALUES (${unfinished}, 'operator', 'unfinished.txt', 'text/plain; charset=utf-8', 5, 'unfinished', now() - interval '2 days')`;
        await writeFile(path.join(directory, unfinished), "part");
        await writeFile(path.join(directory, "unrelated"), "Retain");
        expect(await cleanupMiraFiles(fixture.client, directory)).toBe(1);
        await fixture.client`UPDATE mira_attachments SET deleted_at = now() WHERE id = ${input.id}`;
        expect(await cleanupMiraFiles(fixture.client, directory)).toBe(1);
        expect(await cleanupMiraFiles(fixture.client, directory)).toBe(0);
        expect(await readdir(directory)).toEqual(["unrelated"]);
    } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("provider deletion retains retry intent on failure and clears it only after acknowledgement", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const chat = await api.conversations.create({ title: "Delete me" });
        await fixture.client`UPDATE mira_conversations SET provider_thread = 'synthetic-thread' WHERE id = ${chat.id}`;
        await api.conversations.change({ id: chat.id, version: 1, action: "delete" });
        const later = await api.conversations.create({ title: "Delete later" });
        await fixture.client`UPDATE mira_conversations SET provider_thread='later-thread' WHERE id=${later.id}`;
        await api.conversations.change({ id: later.id, version: 1, action: "delete" });
        const attempted: string[] = [];
        await rejects(
            cleanupMiraConversations(fixture.client, {
                deleteThread: (id) => {
                    attempted.push(id);
                    return id === "synthetic-thread"
                        ? Promise.reject(new Error("Synthetic disconnect"))
                        : Promise.resolve();
                },
            }),
            /references remain pending/
        );
        expect(attempted).toEqual(["synthetic-thread", "later-thread"]);
        const [remaining] = await fixture.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_conversations WHERE deleted_at IS NOT NULL AND provider_thread IS NOT NULL`;
        expect(remaining?.count).toBe(1);
        const references: string[] = [];
        expect(
            await cleanupMiraConversations(fixture.client, {
                deleteThread: (id) => {
                    references.push(id);
                    return Promise.resolve();
                },
            })
        ).toBe(1);
        expect(
            await cleanupMiraConversations(fixture.client, {
                deleteThread: () => Promise.reject(new Error("Must not repeat")),
            })
        ).toBe(0);
        expect(references).toEqual(["synthetic-thread"]);
    } finally {
        await fixture.close();
    }
});

test("Mira reserves queue space for user work and rejects overflow without orphaning messages", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        for (let index = 0; index < 28; index++) {
            const chat = await api.conversations.create({ title: `Synthetic ${index}` });
            await api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Queued",
            });
        }
        expect(
            await fixture.client.begin((query) =>
                miraQueueAvailable(query, "operator", false)
            )
        ).toBe(false);
        expect(
            await fixture.client.begin((query) =>
                miraQueueAvailable(query, "operator", true)
            )
        ).toBe(true);
        for (let index = 0; index < 4; index++) {
            const chat = await api.conversations.create({ title: `Manual ${index}` });
            await api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Queued",
            });
        }
        const overflow = await api.conversations.create({ title: "Overflow" });
        await rejects(
            api.conversations.send({
                conversationId: overflow.id,
                requestId: crypto.randomUUID(),
                text: "No space",
            }),
            /queue is full/
        );
        const empty = await api.conversations.read({ id: overflow.id });
        expect(empty.messages).toHaveLength(0);
        expect(
            await claimMiraRun(fixture.client, crypto.randomUUID(), "foreground")
        ).not.toBeNull();
    } finally {
        await fixture.close();
    }
});

test("provider deletion failure does not retain unrelated deleted uploads or abandoned image copies", async () => {
    const fixture = await operationFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-independent-cleanup-"));
    const uploads = path.join(directory, "uploads");
    const abandoned = path.join(directory, "message-files", "turn-old123");
    const context = {
        client: fixture.client,
        owner: "operator",
        actor: "human:operator",
    };
    try {
        await mkdir(uploads);
        await mkdir(abandoned, { recursive: true });
        await writeFile(path.join(abandoned, "image.png"), "Synthetic stale bytes");
        const old = new Date(Date.now() - 2 * 86_400_000);
        await utimes(abandoned, old, old);
        const file = await saveMiraFile(context, uploads, {
            id: crypto.randomUUID(),
            name: "deleted.txt",
            bytes: new TextEncoder().encode("Deleted synthetic bytes"),
        });
        await fixture.client`UPDATE mira_attachments SET deleted_at = now() WHERE id = ${file.id}`;
        const conversation = Bun.randomUUIDv7();
        await fixture.client`INSERT INTO mira_conversations (id, owner, title, provider_thread, deleted_at) VALUES (${conversation}, 'operator', 'Deleted conversation', 'failing-provider-thread', now())`;
        expect(
            await cleanupMiraResources({
                client: fixture.client,
                runtime: {
                    deleteThread: () =>
                        Promise.reject(new Error("Synthetic provider failure")),
                },
                filesDirectory: uploads,
                home: directory,
            })
        ).toBe(false);
        expect(await readdir(uploads)).toEqual([]);
        expect(await readdir(path.join(directory, "message-files"))).toEqual([]);
        const pending = await fixture.client<
            { provider: string | null }[]
        >`SELECT provider_thread AS provider FROM mira_conversations WHERE id = ${conversation}`;
        expect(pending[0]?.provider).toBe("failing-provider-thread");
        expect(
            await cleanupMiraResources({
                client: fixture.client,
                filesDirectory: uploads,
                home: directory,
            })
        ).toBe(true);
    } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("replacement provider threads recover failed-turn context without mixing owners or duplicating resumed history", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const chat = await api.conversations.create({ title: "Recovery context" });
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Please investigate the synthetic solar inverter error ZK-427.",
        });
        const first = await claimMiraRun(
            fixture.client,
            crypto.randomUUID(),
            "foreground"
        );
        if (!first) throw new Error("Expected first run");
        const firstInput = await readMiraTurnInput(fixture.client, first);
        expect(firstInput.content).toBe(
            "Please investigate the synthetic solar inverter error ZK-427."
        );
        await finishMiraRun(fixture.client, first, {
            state: "needs_attention",
            text: "Unverified partial answer",
            message: "Authentication expired before provider thread creation.",
        });
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Try again",
        });
        const retry = await claimMiraRun(
            fixture.client,
            crypto.randomUUID(),
            "foreground"
        );
        if (!retry) throw new Error("Expected retry");
        const restored = await readMiraTurnInput(fixture.client, retry);
        expect(restored.content).toContain("ZK-427");
        expect(restored.content).toContain("Unverified partial answer");
        expect(restored.content).toContain('"state":"failed"');
        expect(restored.content).toEndWith("Current user message:\nTry again");
        await rejects(
            readMiraTurnInput(fixture.client, { ...retry, owner: "other" }),
            /unavailable/
        );
        await fixture.client`UPDATE mira_messages SET content=repeat('Long historical input ',10000) WHERE id=${first.userMessageId}`;
        const bounded = await readMiraTurnInput(fixture.client, retry);
        expect(bounded.content.length).toBeLessThan(50_000);
        expect(bounded.content).toContain('"truncated":true');
        await fixture.client`UPDATE mira_conversations SET provider_thread='already-resumed' WHERE id=${chat.id}`;
        const resumed = await readMiraTurnInput(fixture.client, retry);
        expect(resumed.content).toBe("Try again");
    } finally {
        await fixture.close();
    }
});
