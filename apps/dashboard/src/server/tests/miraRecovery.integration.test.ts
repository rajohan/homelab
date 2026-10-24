import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { capabilities } from "@homelab/contracts/operations";
import { miraQueueAvailable } from "@homelab/mira/data/capacity";
import { cleanupMiraFiles, readMiraFile, saveMiraFile } from "@homelab/mira/data/files";
import { claimMiraRun } from "@homelab/mira/data/queue";

import { cleanupMiraConversations } from "../../../../mira/src/server/executor/cleanup";
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
        await rejects(
            cleanupMiraConversations(fixture.client, {
                deleteThread: () => Promise.reject(new Error("Synthetic disconnect")),
            }),
            /disconnect/
        );
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
