import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import type { MiraTaskInput } from "@homelab/contracts/mira";
import { capabilities } from "@homelab/contracts/operations";
import { saveMemory } from "@homelab/mira/data/documents";
import {
    claimMiraRun,
    finishMiraRun,
    renewMiraRun,
    saveMiraDelta,
    scheduleMiraRuns,
} from "@homelab/mira/data/queue";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";

import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

const page = { search: "", archived: false };
const task: MiraTaskInput = {
    title: "Synthetic task",
    description: "A bounded synthetic check.",
    status: "todo",
    assignee: "mira",
    priority: "normal",
    labels: ["test"],
    dueAt: null,
    completionCriteria: "The check passes.",
    conversationId: null,
};
async function fixture() {
    const database = await operationFixture();
    const caller = (id = "operator") =>
        appRouter.createCaller({
            operations: database,
            principal: { kind: "human", id, capabilities },
        });
    return { ...database, caller };
}

test("Mira HTTP API isolates operators, rejects machine access and retains durable chat after reconnect", async () => {
    const database = await fixture();
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) =>
            fetchRequestHandler({
                endpoint: "/trpc",
                req: request,
                router: appRouter,
                createContext: () => ({
                    operations: database,
                    principal: { kind: "human" as const, id: "operator", capabilities },
                }),
            }),
    });
    const api = () =>
        createTRPCClient<typeof appRouter>({
            links: [
                httpBatchLink({
                    url: `http://127.0.0.1:${server.port}/trpc`,
                    transformer: superjson,
                }),
            ],
        });
    try {
        const chat = await api().mira.conversations.create.mutate({
            title: "Synthetic conversation",
        });
        const input = {
            conversationId: chat.id,
            requestId: Bun.randomUUIDv7(),
            text: "Remember this synthetic message.",
            attachmentIds: [],
        };
        const submitted = await api().mira.conversations.send.mutate(input);
        expect(await api().mira.conversations.send.mutate(input)).toEqual(submitted);
        await rejects(
            api().mira.conversations.send.mutate({ ...input, text: "Different content" }),
            /already belongs/
        );
        const reconnected = await api().mira.conversations.read.query({ id: chat.id });
        expect(reconnected.messages).toHaveLength(2);
        expect(
            reconnected.messages.find((message) => message.role === "user")?.content
        ).toBe(input.text);
        expect(reconnected.run?.state).toBe("queued");
        const otherChats = await database.caller("other").mira.conversations.list(page);
        expect(otherChats.rows).toHaveLength(0);
        await rejects(
            database.caller("other").mira.conversations.read({ id: chat.id }),
            /not found/
        );
        const machine = appRouter.createCaller({
            operations: database,
            principal: { kind: "automation", id: "machine", capabilities },
        });
        await rejects(machine.mira.conversations.list(page), /signed-in operator/);
    } finally {
        await server.stop(true);
        await database.close();
    }
});

test("Mira task versions, ownership and explicit memory deletion preserve correct audit", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const created = await api.tasks.create(task);
        await api.tasks.update({
            ...task,
            id: created.id,
            version: 1,
            status: "in_progress",
        });
        await rejects(
            api.tasks.update({ ...task, id: created.id, version: 1 }),
            /changed/
        );
        await rejects(
            database
                .caller("other")
                .mira.tasks.addProgress({ taskId: created.id, text: "Not authorized" }),
            /not found/
        );
        await api.tasks.addProgress({ taskId: created.id, text: "Observed progress" });
        const progress = await api.tasks.progress({ id: created.id });
        expect(progress.rows[0]?.actor).toBe("human:operator");
        const tasks = await api.tasks.list({ ...page, status: "in_progress" });
        expect(tasks.rows).toHaveLength(1);
        const memory = await api.memory.create({
            title: "Preference",
            content: "Synthetic private content",
        });
        await api.memory.delete({ id: memory.id, version: 1 });
        const memories = await api.memory.list(page);
        expect(memories.rows).toHaveLength(0);
        const audit = await database.client<
            { action: string; actor: string }[]
        >`SELECT action, actor FROM mira_audit WHERE target = ${memory.id}`;
        expect(audit.map((entry) => entry.action)).toEqual([
            "memory.created",
            "memory.deleted",
        ]);
        expect(JSON.stringify(audit)).not.toContain("Synthetic private content");
    } finally {
        await database.close();
    }
});

test("a foreground agent turn runs while the general agent lane is occupied", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const first = await api.conversations.create({ title: "First" });
        const second = await api.conversations.create({ title: "Second" });
        const one = await api.conversations.send({
            conversationId: first.id,
            requestId: Bun.randomUUIDv7(),
            text: "One",
        });
        const worker = crypto.randomUUID();
        const general = await claimMiraRun(database.client, worker, "general");
        expect(general?.id).toBe(one.id);
        const two = await api.conversations.send({
            conversationId: second.id,
            requestId: Bun.randomUUIDv7(),
            text: "Two",
        });
        const foreground = await claimMiraRun(database.client, worker, "foreground");
        expect(foreground?.id).toBe(two.id);
        expect(
            await claimMiraRun(database.client, crypto.randomUUID(), "foreground")
        ).toBeNull();
        expect(
            await claimMiraRun(database.client, crypto.randomUUID(), "general")
        ).toBeNull();
        expect(await saveMiraDelta(database.client, foreground!, "Streamed text")).toBe(
            true
        );
        const streaming = await api.conversations.read({ id: second.id });
        expect(streaming.messages.at(-1)?.content).toBe("Streamed text");
        await api.runs.cancel({ id: foreground!.id });
        expect(await renewMiraRun(database.client, foreground!)).toBe(false);
        expect(
            await finishMiraRun(database.client, foreground!, {
                state: "interrupted",
                text: "Streamed text",
                message: null,
            })
        ).toBe(true);
        const stopped = await api.conversations.read({ id: second.id });
        expect(stopped.run?.state).toBe("interrupted");
    } finally {
        await database.close();
    }
});

test("expired agent leases cannot overwrite reconciled outcomes or commit product mutations", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const chat = await api.conversations.create({ title: "Lease check" });
        await api.conversations.send({
            conversationId: chat.id,
            requestId: Bun.randomUUIDv7(),
            text: "Synthetic",
        });
        const run = await claimMiraRun(database.client, crypto.randomUUID(), "general");
        expect(run).not.toBeNull();
        await database.client`UPDATE mira_runs SET lease_expires_at = now() - interval '1 second' WHERE id = ${run!.id}`;
        expect(
            await claimMiraRun(database.client, crypto.randomUUID(), "general")
        ).toBeNull();
        expect(await saveMiraDelta(database.client, run!, "Stale overwrite")).toBe(false);
        expect(
            await finishMiraRun(database.client, run!, {
                state: "completed",
                text: "Wrong success",
                message: null,
            })
        ).toBe(false);
        await rejects(
            saveMemory(
                {
                    client: database.client,
                    owner: "operator",
                    actor: `mira:${run!.id}`,
                    run: { id: run!.id, leaseToken: run!.leaseToken },
                },
                { title: "Stale write", content: "Must roll back" }
            ),
            /permission/
        );
        const memories = await api.memory.list(page);
        expect(memories.rows).toHaveLength(0);
        const reconciled = await api.conversations.read({ id: chat.id });
        expect(reconciled.run?.state).toBe("needs_attention");
    } finally {
        await database.close();
    }
});

test("Mira recurrence survives completion, skips disabled queued work and resumes without catch-up", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const automation = await api.automations.create({
            title: "Synthetic recurring review",
            prompt: "Read synthetic state only.",
            kind: "custom",
            schedule: { kind: "interval", intervalSeconds: 60 },
            budgetSeconds: 60,
        });
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            version: 1,
            enabled: true,
            reason: null,
            until: null,
        });
        await database.client`UPDATE mira_automations SET next_run_at = now() - interval '1 hour' WHERE id = ${automation.id}`;
        expect(await scheduleMiraRuns(database.client)).toBe(1);
        expect(await scheduleMiraRuns(database.client)).toBe(0);
        const initialRuns = await api.runs.list(page);
        const queued = initialRuns.rows[0]!;
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            version: 2,
            enabled: false,
            reason: "Planned pause",
            until: null,
        });
        expect(
            await claimMiraRun(database.client, crypto.randomUUID(), "general")
        ).toBeNull();
        const disabledRuns = await api.runs.list(page);
        expect(disabledRuns.rows[0]?.state).toBe("interrupted");
        const disabledControls = await api.controls.list();
        expect(
            disabledControls.find((row) => row.key === `automation:${automation.id}`)
                ?.reason
        ).toBe("Planned pause");
        await api.automations.update({
            id: automation.id,
            version: 1,
            title: "Edited while disabled",
            prompt: "Still quiet",
            kind: "custom",
            schedule: { kind: "interval", intervalSeconds: 60 },
            budgetSeconds: 60,
        });
        const editedControls = await api.controls.list();
        expect(
            editedControls.find((row) => row.key === `automation:${automation.id}`)
                ?.enabled
        ).toBe(false);
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            version: 3,
            enabled: true,
            reason: null,
            until: null,
        });
        expect(await scheduleMiraRuns(database.client)).toBe(0);
        const resumedRuns = await api.runs.list(page);
        expect(resumedRuns.rows[0]?.id).toBe(queued.id);
    } finally {
        await database.close();
    }
});

test("Mira refuses foreign attachments atomically and requires stopped runs before deleting chat content", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const chat = await api.conversations.create({ title: "Private chat" });
        await rejects(
            api.conversations.send({
                conversationId: chat.id,
                requestId: Bun.randomUUIDv7(),
                text: "No attachment authority",
                attachmentIds: [crypto.randomUUID()],
            }),
            /attachment/
        );
        const empty = await api.conversations.read({ id: chat.id });
        expect(empty.messages).toHaveLength(0);
        const run = await api.conversations.send({
            conversationId: chat.id,
            requestId: Bun.randomUUIDv7(),
            text: "Sensitive synthetic content",
        });
        await rejects(
            api.conversations.change({ id: chat.id, version: 2, action: "delete" }),
            /Stop the active run/
        );
        await api.runs.cancel(run);
        await api.conversations.change({ id: chat.id, version: 2, action: "delete" });
        await rejects(api.conversations.read({ id: chat.id }), /not found/);
        const content = await database.client<
            { content: string }[]
        >`SELECT content FROM mira_messages WHERE conversation_id = ${chat.id}`;
        expect(content.every((row) => row.content === "")).toBe(true);
    } finally {
        await database.close();
    }
});
