import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { miraModelSchema } from "@homelab/contracts/mira";
import type { MiraTaskInput } from "@homelab/contracts/mira";
import { capabilities } from "@homelab/contracts/operations";
import { createReport, saveMemory } from "@homelab/mira/data/documents";
import { recordMiraEvent } from "@homelab/mira/data/events";
import {
    claimMiraRun,
    finishMiraRun,
    renewMiraRun,
    reconcileMiraRuns,
    saveMiraDelta,
    saveMiraActivity,
    scheduleMiraRuns,
} from "@homelab/mira/data/queue";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import * as v from "valibot";

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
        const history = await api().mira.runs.list.query(page);
        expect(history.rows[0]).toMatchObject({
            title: "Synthetic conversation",
            conversationAvailable: true,
            automationName: null,
        });
        const otherRuns = await database.caller("other").mira.runs.list(page);
        expect(otherRuns.rows).toHaveLength(0);
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
        await database.client`INSERT INTO mira_runtime_status (id,worker_id,version,ready,heartbeat_at) VALUES (1,${crypto.randomUUID()},'offline',false,now())`;
        expect(await reconcileMiraRuns(database.client)).toBe(1);
        expect(await reconcileMiraRuns(database.client)).toBe(0);
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
        await api.conversations.change({
            id: chat.id,
            version: reconciled.conversation.version,
            action: "archive",
        });
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
        const linkedTask = await api.tasks.create({ ...task, conversationId: chat.id });
        const report = await createReport(
            { client: database.client, owner: "operator", actor: "human:operator" },
            {
                title: "Linked report",
                kind: "other",
                markdown: "Synthetic result",
                taskId: null,
            },
            run.id
        );
        await api.runs.cancel(run);
        await api.conversations.change({ id: chat.id, version: 2, action: "delete" });
        const tasks = await api.tasks.list({ search: "" });
        expect(tasks.rows.find((entry) => entry.id === linkedTask.id)).toMatchObject({
            conversationId: null,
            version: 2,
        });
        const readReport = await api.reports.read(report);
        expect(readReport.conversationId).toBeNull();
        const reports = await api.reports.list(page);
        expect(reports.rows[0]?.conversationId).toBeNull();
        const history = await api.runs.list(page);
        expect(history.rows[0]?.conversationAvailable).toBe(false);
        await rejects(api.conversations.read({ id: chat.id }), /not found/);
        const content = await database.client<
            { content: string }[]
        >`SELECT content FROM mira_messages WHERE conversation_id = ${chat.id}`;
        expect(content.every((row) => row.content === "")).toBe(true);
    } finally {
        await database.close();
    }
});

test("conversation settings validate model capabilities, isolate owners and remain fixed for queued turns", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const chat = await api.conversations.create({ title: "Model settings" });
        const models = [
            v.parse(miraModelSchema, {
                model: "synthetic-a",
                isDefault: true,
                defaultReasoningEffort: "low",
                supportedReasoningEfforts: [
                    { reasoningEffort: "low", description: "Fast" },
                    { reasoningEffort: "high", description: "Deeper" },
                ],
                serviceTiers: [
                    { id: "priority", name: "Fast", description: "Higher usage" },
                ],
            }),
        ];
        await database.client`INSERT INTO mira_runtime_status (id, worker_id, version, model, models, ready, heartbeat_at) VALUES (1, ${crypto.randomUUID()}, 'synthetic', 'synthetic-a', ${JSON.stringify(models)}::text::jsonb, true, now())`;
        const settings = {
            model: "synthetic-a",
            effort: "high",
            serviceTier: "priority",
        };
        await rejects(
            database
                .caller("other")
                .mira.conversations.settings({ id: chat.id, version: 1, settings }),
            /changed/
        );
        await rejects(
            api.conversations.settings({
                id: chat.id,
                version: 1,
                settings: { ...settings, effort: "unsupported" },
            }),
            /thinking level/
        );
        await rejects(
            api.conversations.settings({
                id: chat.id,
                version: 1,
                settings: { ...settings, model: "missing" },
            }),
            /unavailable/
        );
        await api.conversations.settings({ id: chat.id, version: 1, settings });
        const read = await api.conversations.read({ id: chat.id });
        expect(read.conversation.settings).toEqual(settings);
        expect(read.conversation.version).toBe(2);
        await rejects(
            api.conversations.settings({ id: chat.id, version: 1, settings }),
            /changed/
        );
        const queued = await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Synthetic settings check",
        });
        await rejects(
            api.conversations.settings({ id: chat.id, version: 3, settings }),
            /Wait for the reply/
        );
        const [stored] = await database.client<
            { settings: unknown }[]
        >`SELECT settings FROM mira_runs WHERE id = ${queued.id}`;
        expect(stored?.settings).toEqual(settings);
        const claimed = await claimMiraRun(
            database.client,
            crypto.randomUUID(),
            "foreground"
        );
        expect(claimed?.id).toBe(queued.id);
        expect(
            await saveMiraActivity(database.client, claimed!, {
                phase: "thinking",
                tool: null,
            })
        ).toBe(true);
        const thinking = await api.conversations.read({ id: chat.id });
        expect(thinking.run?.activity).toEqual({ phase: "thinking", tool: null });
        await api.runs.cancel({ id: queued.id });
        expect(
            await saveMiraActivity(database.client, claimed!, {
                phase: "replying",
                tool: null,
            })
        ).toBe(false);
        await finishMiraRun(database.client, claimed!, {
            state: "interrupted",
            text: "",
            message: null,
        });
        await database.client`UPDATE mira_runtime_status SET heartbeat_at = now() - interval '1 minute'`;
        await rejects(
            api.conversations.settings({ id: chat.id, version: 3, settings }),
            /Reconnect/
        );
    } finally {
        await database.close();
    }
});

test.each(["active run", "full queue"])(
    "one-time automations retain a due occurrence during %s",
    async (blocker) => {
        const database = await fixture();
        try {
            const api = database.caller().mira;
            const at = new Date(Date.now() + 60_000);
            const automation = await api.automations.create({
                title: "Run once",
                prompt: "Synthetic check",
                kind: "custom",
                schedule: { kind: "once", at: at.toISOString() },
                budgetSeconds: 60,
            });
            await api.controls.setEnabled({
                key: `automation:${automation.id}`,
                version: 1,
                enabled: true,
                reason: null,
                until: null,
            });
            let blockedRun: string;
            if (blocker === "active run") {
                const manual = await api.automations.run({
                    id: automation.id,
                    requestId: crypto.randomUUID(),
                });
                blockedRun = manual.id;
            } else {
                blockedRun = "";
                for (let index = 0; index < 28; index++) {
                    const chat = await api.conversations.create({
                        title: `Capacity ${index}`,
                    });
                    const queued = await api.conversations.send({
                        conversationId: chat.id,
                        requestId: crypto.randomUUID(),
                        text: "Synthetic",
                    });
                    blockedRun = queued.id;
                }
            }
            const now = new Date(at.getTime() + 1);
            expect(await scheduleMiraRuns(database.client, now)).toBe(0);
            const [waiting] = await database.client<
                { due: Date | null }[]
            >`SELECT next_run_at AS due FROM mira_automations WHERE id=${automation.id}`;
            expect(waiting?.due).not.toBeNull();
            await api.runs.cancel({ id: blockedRun });
            expect(await scheduleMiraRuns(database.client, now)).toBe(1);
            expect(await scheduleMiraRuns(database.client, now)).toBe(0);
            const [finished] = await database.client<
                { due: Date | null }[]
            >`SELECT next_run_at AS due FROM mira_automations WHERE id=${automation.id}`;
            expect(finished?.due).toBeNull();
        } finally {
            await database.close();
        }
    }
);

test("verified events reach every enabled subscriber across pagination boundaries exactly once", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        for (let index = 0; index < 105; index++) {
            const automation = await api.automations.create({
                title: `Subscriber ${index}`,
                prompt: "Synthetic event review",
                kind: "custom",
                schedule: { kind: "event", event: "task_due" },
                budgetSeconds: 60,
            });
            await api.controls.setEnabled({
                key: `automation:${automation.id}`,
                version: 1,
                enabled: true,
                reason: null,
                until: null,
            });
        }
        const event = {
            owner: "operator",
            kind: "task_due" as const,
            key: "synthetic-event",
            reference: "synthetic",
        };
        expect(
            await database.client.begin((query) => recordMiraEvent(query, event))
        ).toBe(true);
        expect(
            await database.client.begin((query) => recordMiraEvent(query, event))
        ).toBe(false);
        const [deliveries] = await database.client<
            { count: number }[]
        >`SELECT count(*)::integer AS count FROM mira_event_deliveries`;
        expect(deliveries?.count).toBe(105);
    } finally {
        await database.close();
    }
});

test("explicit task starts are owner-scoped, idempotent and independent of board status", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const created = await api.tasks.create(task);
        const input = {
            id: created.id,
            version: 1,
            requestId: crypto.randomUUID(),
            instructions: "Check the recorded state only.",
        };
        await rejects(database.caller("other").mira.tasks.run(input), /not found/);
        const [first, retried] = await Promise.all([
            api.tasks.run(input),
            api.tasks.run(input),
        ]);
        expect(retried).toEqual(first);
        await rejects(
            api.tasks.run({ ...input, instructions: "Different work" }),
            /different task action/
        );
        const listed = await api.tasks.list(page);
        expect(listed.rows[0]).toMatchObject({
            id: created.id,
            status: "todo",
            version: 2,
            conversationId: first.conversationId,
        });
        const execution = await api.tasks.execution({ id: created.id });
        expect(execution.rows).toHaveLength(1);
        expect(execution.rows[0]).toMatchObject({
            id: first.id,
            taskId: created.id,
            state: "queued",
        });
        await rejects(
            database.caller("other").mira.tasks.execution({ id: created.id }),
            /not found/
        );
        await rejects(api.tasks.delete({ id: created.id, version: 2 }), /Stop or finish/);
        await rejects(
            api.tasks.run({ ...input, version: 2, requestId: crypto.randomUUID() }),
            /current task run/
        );
        await api.runs.cancel({ id: first.id });
        const continued = await api.tasks.run({
            ...input,
            version: 2,
            requestId: crypto.randomUUID(),
        });
        expect(continued.conversationId).toBe(first.conversationId);
        expect(continued.id).not.toBe(first.id);
        const history = await api.tasks.execution({ id: created.id });
        expect(history.rows).toHaveLength(2);
        await api.runs.cancel({ id: continued.id });
        await api.tasks.delete({ id: created.id, version: 3 });
        await rejects(
            api.tasks.run({ ...input, version: 3, requestId: crypto.randomUUID() }),
            /not found/
        );
    } finally {
        await database.close();
    }
});

test("task continuation requires review of uncertain actions and never rewrites their receipts", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const created = await api.tasks.create(task);
        const first = await api.tasks.run({
            id: created.id,
            version: 1,
            requestId: crypto.randomUUID(),
        });
        const claim = await claimMiraRun(
            database.client,
            crypto.randomUUID(),
            "foreground"
        );
        expect(claim?.id).toBe(first.id);
        await database.client`INSERT INTO mira_tool_receipts (id, run_id, call_id, tool, input_hash, state) VALUES (${Bun.randomUUIDv7()}, ${first.id}, 'uncertain', 'synthetic_action', 'synthetic', 'running')`;
        await database.client`UPDATE mira_runs SET lease_expires_at = now() - interval '1 second' WHERE id = ${first.id}`;
        await reconcileMiraRuns(database.client);
        const execution = await api.tasks.execution({ id: created.id });
        expect(execution.reviewRunId).toBe(first.id);
        const resume = { id: created.id, version: 2, requestId: crypto.randomUUID() };
        await rejects(api.tasks.run(resume), /Review the uncertain run/);
        await rejects(
            api.tasks.run({ ...resume, reviewedRunId: crypto.randomUUID() }),
            /Review the uncertain run/
        );
        const continued = await api.tasks.run({ ...resume, reviewedRunId: first.id });
        expect(continued.conversationId).toBe(first.conversationId);
        const receipts = await database.client<
            { state: string }[]
        >`SELECT state FROM mira_tool_receipts WHERE run_id = ${first.id}`;
        expect(receipts).toEqual([{ state: "unknown" }]);
        const conversation = await api.conversations.read({ id: first.conversationId });
        expect(conversation.messages.at(-2)?.content).toContain(first.id);
        const acknowledged = await api.tasks.execution({ id: created.id });
        expect(acknowledged.reviewRunId).toBeNull();
        await api.runs.cancel({ id: continued.id });
        const next = await api.tasks.run({
            id: created.id,
            version: 3,
            requestId: crypto.randomUUID(),
        });
        expect(next.conversationId).toBe(first.conversationId);
    } finally {
        await database.close();
    }
});

test("automatic task events and a manual start share one execution slot per task", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const created = await api.tasks.create({
            ...task,
            dueAt: new Date(Date.now() - 1000).toISOString(),
        });
        const automation = await api.automations.create({
            title: "Due-task review",
            prompt: "Review due tasks",
            kind: "custom",
            schedule: { kind: "event", event: "task_due" },
            budgetSeconds: 60,
        });
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            enabled: true,
            version: 1,
            reason: null,
            until: null,
        });
        const [scheduled] = await Promise.allSettled([
            scheduleMiraRuns(database.client),
            api.tasks.run({ id: created.id, version: 1, requestId: crypto.randomUUID() }),
        ]);
        expect(scheduled.status).toBe("fulfilled");
        const runs = await api.tasks.execution({ id: created.id });
        expect(runs.rows).toHaveLength(1);
        expect(runs.rows[0]).toMatchObject({ taskId: created.id, state: "queued" });
        const unrelated = await api.tasks.create({ ...task, title: "Different task" });
        const separate = await api.tasks.execution({ id: unrelated.id });
        expect(separate.rows).toHaveLength(0);
    } finally {
        await database.close();
    }
});

test("completed or operator-owned tasks cannot start and archived task context is preserved", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        for (const fields of [
            { status: "done" as const },
            { assignee: "operator" as const },
        ]) {
            const saved = await api.tasks.create({ ...task, ...fields });
            await rejects(
                api.tasks.run({
                    id: saved.id,
                    version: 1,
                    requestId: crypto.randomUUID(),
                }),
                /unfinished task to Mira/
            );
        }
        const chat = await api.conversations.create({ title: "Archived task context" });
        const saved = await api.tasks.create({ ...task, conversationId: chat.id });
        await api.conversations.change({ id: chat.id, version: 1, action: "archive" });
        await rejects(
            api.tasks.run({ id: saved.id, version: 1, requestId: crypto.randomUUID() }),
            /Restore the task/
        );
        await api.conversations.change({ id: chat.id, version: 2, action: "restore" });
        const started = await api.tasks.run({
            id: saved.id,
            version: 1,
            requestId: crypto.randomUUID(),
        });
        expect(started.conversationId).toBe(chat.id);
    } finally {
        await database.close();
    }
});

test.each(["needs_attention", "unknown receipt"])(
    "automatic task delivery waits for explicit review after %s",
    async (outcome) => {
        const database = await fixture();
        try {
            const api = database.caller().mira;
            const saved = await api.tasks.create({
                ...task,
                dueAt: new Date(Date.now() - 1000).toISOString(),
            });
            const first = await api.tasks.run({
                id: saved.id,
                version: 1,
                requestId: crypto.randomUUID(),
            });
            const automation = await api.automations.create({
                title: "Due task",
                prompt: "Review due tasks",
                kind: "custom",
                schedule: { kind: "event", event: "task_due" },
                budgetSeconds: 60,
            });
            await api.controls.setEnabled({
                key: `automation:${automation.id}`,
                version: 1,
                enabled: true,
                reason: null,
                until: null,
            });
            expect(await scheduleMiraRuns(database.client)).toBe(0);
            await api.runs.cancel({ id: first.id });
            await (outcome === "needs_attention"
                ? database.client`UPDATE mira_runs SET state='needs_attention' WHERE id=${first.id}`
                : database.client`INSERT INTO mira_tool_receipts (id, run_id, call_id, tool, input_hash, state) VALUES (${Bun.randomUUIDv7()}, ${first.id}, 'uncertain', 'synthetic_action', 'synthetic', 'unknown')`);
            const now = new Date(Date.now() + 31_000);
            expect(await scheduleMiraRuns(database.client, now)).toBe(0);
            const waiting = await database.client<
                { state: string }[]
            >`SELECT state FROM mira_event_deliveries`;
            expect(waiting).toEqual([{ state: "pending" }]);
            const blockedHistory = await api.tasks.execution({ id: saved.id });
            expect(blockedHistory.rows).toHaveLength(1);
            const reviewed = await api.tasks.run({
                id: saved.id,
                version: 2,
                requestId: crypto.randomUUID(),
                reviewedRunId: first.id,
            });
            expect(
                await scheduleMiraRuns(database.client, new Date(now.getTime() + 31_000))
            ).toBe(0);
            await api.runs.cancel({ id: reviewed.id });
            expect(
                await scheduleMiraRuns(database.client, new Date(now.getTime() + 62_000))
            ).toBe(1);
            const history = await api.tasks.execution({ id: saved.id });
            expect(history.reviewRunId).toBeNull();
            expect(history.rows).toHaveLength(3);
            expect(history.rows[0]?.automationId).toBe(automation.id);
            const [index] = await database.client<
                { definition: string }[]
            >`SELECT indexdef AS definition FROM pg_indexes WHERE schemaname='public' AND indexname='mira_runs_task'`;
            expect(index?.definition).toContain("(owner, task_id, id)");
        } finally {
            await database.close();
        }
    }
);

test("linked chat sends retain task history, admission and retry identity", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const saved = await api.tasks.create(task);
        const initial = await api.tasks.run({
            id: saved.id,
            version: 1,
            requestId: Bun.randomUUIDv7(),
        });
        await api.runs.cancel({ id: initial.id });
        const input = {
            conversationId: initial.conversationId,
            requestId: Bun.randomUUIDv7(),
            text: "Continue the saved task.",
        };
        const continued = await api.conversations.send(input);
        expect(await api.conversations.send(input)).toEqual(continued);
        const history = await api.tasks.execution({ id: saved.id });
        expect(history.rows.map((run) => run.id)).toContain(continued.id);
        await rejects(
            api.tasks.run({
                id: saved.id,
                version: history.version,
                requestId: Bun.randomUUIDv7(),
            }),
            /current task run/
        );
        await rejects(
            database
                .caller("other")
                .mira.conversations.send({ ...input, requestId: Bun.randomUUIDv7() }),
            /active conversation/
        );
        await api.runs.cancel({ id: continued.id });
        await database.client`UPDATE mira_runs SET state = 'needs_attention' WHERE id = ${continued.id}`;
        expect(await api.conversations.send(input)).toEqual(continued);
        await rejects(
            api.conversations.send({ ...input, requestId: Bun.randomUUIDv7() }),
            /Review the uncertain run/
        );
        await database.client`UPDATE mira_runs SET state = 'failed' WHERE id = ${continued.id}`;
        await database.client`INSERT INTO mira_tool_receipts (id, run_id, call_id, tool, input_hash, state) VALUES (${Bun.randomUUIDv7()}, ${continued.id}, 'synthetic', 'synthetic', 'synthetic', 'unknown')`;
        await rejects(
            api.conversations.send({ ...input, requestId: Bun.randomUUIDv7() }),
            /Review the uncertain run/
        );
        const reviewed = await api.tasks.run({
            id: saved.id,
            version: history.version,
            requestId: Bun.randomUUIDv7(),
            reviewedRunId: continued.id,
        });
        await api.runs.cancel({ id: reviewed.id });
        const afterReview = await api.conversations.send({
            ...input,
            requestId: Bun.randomUUIDv7(),
        });
        const reviewedHistory = await api.tasks.execution({ id: saved.id });
        expect(reviewedHistory.rows.map((run) => run.id)).toContain(afterReview.id);
    } finally {
        await database.close();
    }
});

test("linked chat cannot race task admission or overlap work in another conversation", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const chat = await api.conversations.create({ title: "Linked task" });
        const saved = await api.tasks.create({ ...task, conversationId: chat.id });
        const input = {
            conversationId: chat.id,
            requestId: Bun.randomUUIDv7(),
            text: "Continue.",
        };
        await database.client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:task:operator:${saved.id}`}, 0))`;
            await rejects(api.conversations.send(input), /Task admission is busy/);
        });
        const otherChat = await api.conversations.create({
            title: "Automatic task context",
        });
        const automatic = await api.conversations.send({
            ...input,
            conversationId: otherChat.id,
            requestId: Bun.randomUUIDv7(),
        });
        await database.client`UPDATE mira_runs SET task_id = ${saved.id} WHERE id = ${automatic.id}`;
        await rejects(api.conversations.send(input), /current task run/);
        await api.runs.cancel({ id: automatic.id });
        await api.tasks.update({
            ...task,
            id: saved.id,
            version: 1,
            conversationId: chat.id,
            status: "done",
        });
        await rejects(api.conversations.send(input), /unfinished task/);
        await api.tasks.update({
            ...task,
            id: saved.id,
            version: 2,
            conversationId: chat.id,
        });
        const second = await api.tasks.create({ ...task, conversationId: chat.id });
        await rejects(api.conversations.send(input), /multiple tasks/);
        await rejects(
            api.tasks.run({ id: saved.id, version: 3, requestId: Bun.randomUUIDv7() }),
            /multiple tasks/
        );
        await api.tasks.delete({ id: second.id, version: 1 });
        const run = await api.conversations.send(input);
        const history = await api.tasks.execution({ id: saved.id });
        expect(history.rows.map((entry) => entry.id)).toContain(run.id);
    } finally {
        await database.close();
    }
});
