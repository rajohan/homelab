import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { miraModelSchema } from "@homelab/contracts/mira";
import type { MiraTaskInput } from "@homelab/contracts/mira";
import { capabilities } from "@homelab/contracts/operations";
import { enqueueTurn } from "@homelab/mira/data/conversations";
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
import { runMiraTask } from "@homelab/mira/data/taskExecution";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import superjson from "superjson";
import * as v from "valibot";

import { createTestDatabase } from "../../../../../tests/database";
import { appRouter } from "../api/router";
import { connectDashboardDatabase } from "../database/connection";
import {
    dashboardMigrationsFolder,
    migrateDashboard,
    assertDashboardSchema,
} from "../database/migrations";
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
        const generated = await api.conversations.read({ id: first.conversationId });
        expect(generated.conversation.title).toBe(`Task ${created.id.slice(0, 8)}`);
        expect(generated.messages[0]?.content).toContain(created.id);
        expect(generated.messages[0]?.content).toContain("mira_task_read");
        expect(generated.messages[0]?.content).not.toContain(task.title);
        expect(generated.messages[0]?.content).not.toContain(task.completionCriteria);
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
        await rejects(
            api.tasks.create({ ...task, conversationId: chat.id }),
            /already belongs/
        );
        const second = await api.tasks.create(task);
        // Legacy ambiguous links still fail closed, although the editor no longer creates them.
        await database.client`UPDATE mira_tasks SET conversation_id=${chat.id} WHERE id=${second.id}`;
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

test("automatic task conversations retain admission after uncertainty, relinking and deletion", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const saved = await api.tasks.create({
            ...task,
            dueAt: new Date(Date.now() - 1000).toISOString(),
        });
        const automation = await api.automations.create({
            title: "Automatic task",
            prompt: "Review task",
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
        expect(await scheduleMiraRuns(database.client)).toBe(1);
        let history = await api.tasks.execution({ id: saved.id });
        const initial = history.rows[0]!;
        expect(history.conversationId).toBeNull();
        await api.runs.cancel({ id: initial.id });
        await database.client`UPDATE mira_runs SET state='needs_attention' WHERE id=${initial.id}`;
        const input = {
            conversationId: initial.conversationId,
            requestId: crypto.randomUUID(),
            text: "Follow up on this automatic task",
        };
        await rejects(api.conversations.send(input), /Review the uncertain run/);
        const reviewed = await api.tasks.run({
            id: saved.id,
            version: 1,
            requestId: crypto.randomUUID(),
            reviewedRunId: initial.id,
        });
        expect(reviewed.conversationId).not.toBe(initial.conversationId);
        await rejects(api.conversations.send(input), /current task run/);
        await api.runs.cancel({ id: reviewed.id });
        const continued = await api.conversations.send(input);
        history = await api.tasks.execution({ id: saved.id });
        expect(history.rows.map((run) => run.id)).toContain(continued.id);
        await api.runs.cancel({ id: continued.id });
        await rejects(
            api.tasks.create({ ...task, conversationId: initial.conversationId }),
            /already belongs/
        );
        const unrelated = await api.tasks.create(task);
        await database.client`UPDATE mira_tasks SET conversation_id=${initial.conversationId} WHERE id=${unrelated.id}`;
        await rejects(
            api.conversations.send({ ...input, requestId: crypto.randomUUID() }),
            /multiple tasks/
        );
        await api.tasks.update({
            ...task,
            id: unrelated.id,
            version: 1,
            conversationId: null,
        });
        await api.tasks.delete({ id: saved.id, version: history.version });
        await rejects(
            api.conversations.send({ ...input, requestId: crypto.randomUUID() }),
            /deleted task/
        );
    } finally {
        await database.close();
    }
});

test.each(["queued", "running", "needs_attention", "unknown receipt"])(
    "linking a task adopts pre-link %s runs before admission",
    async (state) => {
        const database = await fixture();
        try {
            const api = database.caller().mira;
            const chat = await api.conversations.create({
                title: "Existing ordinary work",
            });
            const first = await api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Inspect before linking",
            });
            if (state === "running")
                await claimMiraRun(database.client, crypto.randomUUID(), "foreground");
            if (state === "needs_attention" || state === "unknown receipt") {
                await api.runs.cancel({ id: first.id });
                await (state === "needs_attention"
                    ? database.client`UPDATE mira_runs SET state='needs_attention' WHERE id=${first.id}`
                    : database.client`INSERT INTO mira_tool_receipts (id,run_id,call_id,tool,input_hash,state) VALUES (${Bun.randomUUIDv7()},${first.id},'uncertain','synthetic','synthetic','unknown')`);
            }
            const saved = await api.tasks.create({
                ...task,
                conversationId: chat.id,
                dueAt: new Date(Date.now() - 1000).toISOString(),
            });
            const automation = await api.automations.create({
                title: "Due task",
                prompt: "Review",
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
            const history = await api.tasks.execution({ id: saved.id });
            expect(history.rows.map((run) => run.id)).toEqual([first.id]);
            expect(history.rows[0]?.taskId).toBe(saved.id);
            expect(await scheduleMiraRuns(database.client)).toBe(0);
            const start = { id: saved.id, version: 1, requestId: crypto.randomUUID() };
            await rejects(
                api.tasks.run(start),
                /current task run|Review the uncertain run/
            );
            if (["needs_attention", "unknown receipt"].includes(state)) {
                expect(history.reviewRunId).toBe(first.id);
                const resumed = await api.tasks.run({
                    ...start,
                    reviewedRunId: first.id,
                });
                expect(resumed.conversationId).toBe(chat.id);
            }
            await rejects(
                database
                    .caller("other")
                    .mira.tasks.create({ ...task, conversationId: chat.id }),
                /not found/
            );
        } finally {
            await database.close();
        }
    }
);

test("linking and ordinary send serialize without losing task history", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const chat = await api.conversations.create({ title: "Concurrent link" });
        const saved = await api.tasks.create(task);
        const [linked, sent] = await Promise.all([
            api.tasks.update({
                ...task,
                id: saved.id,
                version: 1,
                conversationId: chat.id,
            }),
            api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Inspect",
            }),
        ]);
        expect(linked.id).toBe(saved.id);
        const history = await api.tasks.execution({ id: saved.id });
        expect(history.rows.map((run) => run.id)).toEqual([sent.id]);
        const empty = await api.tasks.create(task);
        await rejects(
            api.tasks.update({
                ...task,
                id: empty.id,
                version: 1,
                conversationId: chat.id,
            }),
            /already belongs/
        );
        const unchanged = await api.tasks.execution({ id: empty.id });
        expect(unchanged.rows).toHaveLength(0);
        expect(unchanged.conversationId).toBeNull();
    } finally {
        await database.close();
    }
});

test("historical run details retain uncertain receipts across later turns and chat deletion", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const chat = await api.conversations.create({ title: "Historical results" });
        const first = await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "First",
        });
        await api.runs.cancel({ id: first.id });
        const ids: string[] = [];
        for (let index = 0; index < 35; index++) {
            const id = Bun.randomUUIDv7();
            ids.push(id);
            await database.client`INSERT INTO mira_tool_receipts (id,run_id,call_id,tool,input_hash,state,message) VALUES (${id},${first.id},${`old-${index}`},'mira_report_create',${"0".repeat(64)},${index === 0 ? "unknown" : "succeeded"},${index === 0 ? "Verify the original outcome before repeating." : "Recorded"})`;
        }
        const second = await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Another turn",
        });
        const latest = await api.conversations.read({ id: chat.id });
        expect(latest.run?.id).toBe(second.id);
        const detail = await api.runs.read({ id: first.id });
        expect(detail.run).toMatchObject({
            id: first.id,
            title: "Historical results",
            conversationAvailable: true,
        });
        expect(detail.rows).toHaveLength(32);
        const older = await api.runs.read({ id: first.id, before: detail.nextCursor! });
        expect(older.rows).toHaveLength(3);
        expect([...detail.rows, ...older.rows].map((row) => row.id)).toEqual(
            ids.toReversed()
        );
        expect(older.rows.at(-1)).toMatchObject({
            state: "unknown",
            message: "Verify the original outcome before repeating.",
        });
        expect(JSON.stringify(detail)).not.toContain("inputHash");
        await rejects(
            database.caller("other").mira.runs.read({ id: first.id }),
            /not found/
        );
        await api.runs.cancel({ id: second.id });
        const current = await api.conversations.read({ id: chat.id });
        await api.conversations.change({
            id: chat.id,
            version: current.conversation.version,
            action: "delete",
        });
        const deleted = await api.runs.read({ id: first.id });
        expect(deleted.run).toMatchObject({
            title: "Deleted conversation",
            conversationAvailable: false,
        });
        const retained = await api.runs.read({
            id: first.id,
            before: detail.nextCursor!,
        });
        expect(retained.rows.at(-1)?.state).toBe("unknown");
    } finally {
        await database.close();
    }
});

test("task execution upgrades the migrated AgentMail parent without skipping earlier feature changes", async () => {
    const allocation = await createTestDatabase();
    const connection = connectDashboardDatabase(allocation.url);
    const prior = await mkdtemp(path.join(tmpdir(), "mira-task-parent-"));
    try {
        const source = dashboardMigrationsFolder();
        const entries = await readdir(source, { withFileTypes: true });
        const feature = entries.find((entry) =>
            entry.name.endsWith("_mira_task_execution")
        );
        if (!feature) throw new Error("Expected task execution migration");
        for (const entry of entries.filter(
            (entry) => entry.isDirectory() && entry.name < feature.name
        ))
            await cp(path.join(source, entry.name), path.join(prior, entry.name), {
                recursive: true,
            });
        await migrate(connection.database, { migrationsFolder: prior });
        expect(
            await connection.client`SELECT column_name FROM information_schema.columns WHERE table_name='mira_runs' AND column_name='reviewed_run_id'`
        ).toHaveLength(0);
        const legacy: { taskId: string; runId: string; conversationId: string }[] = [];
        for (const state of ["queued", "needs_attention", "completed"]) {
            const taskId = crypto.randomUUID(),
                runId = crypto.randomUUID(),
                conversationId = crypto.randomUUID(),
                userId = crypto.randomUUID(),
                assistantId = crypto.randomUUID();
            await connection.client`INSERT INTO mira_conversations(id,owner,title) VALUES (${conversationId},'operator','Legacy conversation')`;
            await connection.client`INSERT INTO mira_tasks(id,owner,title,description,status,assignee,priority,completion_criteria,conversation_id) VALUES (${taskId},'operator','Legacy task','','in_progress','mira','normal','',${conversationId})`;
            await connection.client`INSERT INTO mira_messages(id,conversation_id,role,state) VALUES (${userId},${conversationId},'user','completed'),(${assistantId},${conversationId},'assistant','completed')`;
            await connection.client`INSERT INTO mira_runs(id,owner,request_key,request_hash,conversation_id,user_message_id,assistant_message_id,state,priority,budget_seconds) VALUES (${runId},'operator',${runId},'legacy',${conversationId},${userId},${assistantId},${state},1,60)`;
            if (state === "completed")
                await connection.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES (${crypto.randomUUID()},${runId},'legacy','synthetic','legacy','unknown')`;
            legacy.push({ taskId, runId, conversationId });
        }
        const deletedTask = crypto.randomUUID(),
            deletedChat = crypto.randomUUID(),
            deletedRun = crypto.randomUUID();
        await connection.client`INSERT INTO mira_conversations(id,owner,title) VALUES (${deletedChat},'operator','Deleted legacy task')`;
        await connection.client`INSERT INTO mira_tasks(id,owner,title,description,status,assignee,priority,completion_criteria,conversation_id,deleted_at) VALUES (${deletedTask},'operator','Deleted task','','todo','mira','normal','',${deletedChat},now())`;
        await connection.client`INSERT INTO mira_runs(id,owner,request_key,request_hash,conversation_id,user_message_id,assistant_message_id,state,priority,budget_seconds) SELECT ${deletedRun},owner,${deletedRun},request_hash,${deletedChat},user_message_id,assistant_message_id,'needs_attention',priority,budget_seconds FROM mira_runs WHERE id=${legacy[1]!.runId}`;
        const conflicting = crypto.randomUUID();
        await connection.client`INSERT INTO mira_tasks(id,owner,title,description,status,assignee,priority,completion_criteria,conversation_id) VALUES (${conflicting},'operator','Conflicting task','','todo','mira','normal','',${legacy[0]!.conversationId})`;
        await rejects(
            migrateDashboard(connection),
            /Conflicting task conversation links/
        );
        await connection.client`UPDATE mira_tasks SET conversation_id=NULL WHERE id=${conflicting}`;
        const competingConversation = crypto.randomUUID(),
            competingRun = crypto.randomUUID();
        await connection.client`INSERT INTO mira_conversations(id,owner,title) VALUES (${competingConversation},'operator','Legacy due-task work')`;
        await connection.client`INSERT INTO mira_runs(id,owner,request_key,request_hash,conversation_id,user_message_id,assistant_message_id,task_id,state,priority,budget_seconds) SELECT ${competingRun},owner,${competingRun},request_hash,${competingConversation},user_message_id,assistant_message_id,${legacy[0]!.taskId},'queued',priority,budget_seconds FROM mira_runs WHERE id=${legacy[0]!.runId}`;
        await rejects(migrateDashboard(connection), /Active task run collisions/);
        const unadopted = await connection.client<
            { taskId: string | null }[]
        >`SELECT task_id AS "taskId" FROM mira_runs WHERE id=${legacy[0]!.runId}`;
        expect(unadopted[0]?.taskId).toBeNull();
        await connection.client`UPDATE mira_runs SET state='interrupted' WHERE id=${competingRun}`;

        await migrateDashboard(connection);
        await assertDashboardSchema(connection);
        const [deletedAdoption] = await connection.client<
            { taskId: string }[]
        >`SELECT task_id AS "taskId" FROM mira_runs WHERE id=${deletedRun}`;
        expect(deletedAdoption?.taskId).toBe(deletedTask);
        await rejects(
            connection.client.begin((query) =>
                enqueueTurn(
                    query,
                    { owner: "operator", actor: "human:operator" },
                    {
                        conversationId: deletedChat,
                        requestId: crypto.randomUUID(),
                        text: "Continue",
                        attachmentIds: [],
                    }
                )
            ),
            /deleted task/
        );
        for (const item of legacy) {
            const [adopted] = await connection.client<
                { taskId: string }[]
            >`SELECT task_id AS "taskId" FROM mira_runs WHERE id=${item.runId}`;
            expect(adopted?.taskId).toBe(item.taskId);
            await rejects(
                runMiraTask(
                    {
                        client: connection.client,
                        owner: "operator",
                        actor: "human:operator",
                    },
                    {
                        id: item.taskId,
                        version: 1,
                        requestId: crypto.randomUUID(),
                        instructions: "",
                        reviewedRunId: null,
                    }
                ),
                /current task run|uncertain run/
            );
        }
        await migrateDashboard(connection);
        expect(
            await connection.client`SELECT column_name FROM information_schema.columns WHERE table_name='mira_runs' AND column_name='reviewed_run_id'`
        ).toHaveLength(1);
        expect(
            await connection.client`SELECT indexname FROM pg_indexes WHERE tablename='mira_runs' AND indexname IN ('mira_runs_task','mira_runs_conversation','mira_runs_conversation_history','mira_runs_reviewed_run')`
        ).toHaveLength(4);
    } finally {
        await connection.client.close();
        await allocation.close();
        await rm(prior, { recursive: true, force: true });
    }
});

test("relinking cannot adopt a second active task run and shares the task admission lock", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const saved = await api.tasks.create(task);
        const first = await api.tasks.run({
            id: saved.id,
            version: 1,
            requestId: crypto.randomUUID(),
        });
        const chat = await api.conversations.create({ title: "Separate active work" });
        const second = await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Existing work",
        });
        const update = { ...task, id: saved.id, version: 2, conversationId: chat.id };
        await rejects(api.tasks.update(update), /Stop or finish active work/);
        const [unadopted] = await database.client<
            { taskId: string | null }[]
        >`SELECT task_id AS "taskId" FROM mira_runs WHERE id=${second.id}`;
        expect(unadopted?.taskId).toBeNull();
        await database.client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:task:operator:${saved.id}`},0))`;
            await rejects(api.tasks.update(update), /Task admission is busy/);
        });
        await api.runs.cancel({ id: first.id });
        await api.tasks.update(update);
        const history = await api.tasks.execution({ id: saved.id });
        expect(
            history.rows
                .filter((run) => ["queued", "running"].includes(run.state))
                .map((run) => run.id)
        ).toEqual([second.id]);
    } finally {
        await database.close();
    }
});

test("every adopted uncertain outcome must be reviewed without scheduling intermediate work", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const chat = await api.conversations.create({
            title: "Multiple uncertain outcomes",
        });
        const runs: string[] = [];
        for (const state of ["needs_attention", "unknown receipt"]) {
            const run = await api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: state,
            });
            await api.runs.cancel(run);
            await (state === "needs_attention"
                ? database.client`UPDATE mira_runs SET state='needs_attention' WHERE id=${run.id}`
                : database.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES (${Bun.randomUUIDv7()},${run.id},'unknown','synthetic','synthetic','unknown')`);
            runs.push(run.id);
        }
        const saved = await api.tasks.create({ ...task, conversationId: chat.id });
        const newest = runs[1]!,
            older = runs[0]!;
        await rejects(
            api.tasks.run({
                id: saved.id,
                version: 1,
                requestId: crypto.randomUUID(),
                reviewedRunId: newest,
            }),
            /Review every uncertain/
        );
        await rejects(
            database
                .caller("other")
                .mira.tasks.reviewRun({ id: saved.id, version: 1, runId: newest }),
            /not found/
        );
        await api.tasks.reviewRun({ id: saved.id, version: 1, runId: newest });
        await api.tasks.reviewRun({ id: saved.id, version: 1, runId: newest });
        const middle = await api.tasks.execution({ id: saved.id });
        expect(middle.version).toBe(1);
        expect(middle.reviewRunId).toBe(older);
        expect(middle.rows).toHaveLength(2);
        expect(
            middle.rows.every((run) => !["queued", "running"].includes(run.state))
        ).toBe(true);
        await rejects(
            api.tasks.run({ id: saved.id, version: 1, requestId: crypto.randomUUID() }),
            /Review the uncertain/
        );
        await rejects(
            api.tasks.reviewRun({ id: saved.id, version: 2, runId: older }),
            /task changed/
        );
        await api.tasks.reviewRun({ id: saved.id, version: 1, runId: older });
        const reviewed = await api.tasks.execution({ id: saved.id });
        expect(reviewed.reviewRunId).toBeNull();
        await api.tasks.update({
            ...task,
            id: saved.id,
            version: 1,
            conversationId: chat.id,
            title: "Edited immediately after review",
        });
        const next = await api.tasks.run({
            id: saved.id,
            version: 2,
            requestId: crypto.randomUUID(),
        });
        expect(next.conversationId).toBe(chat.id);
    } finally {
        await database.close();
    }
});

test.each(["archive", "delete"] as const)(
    "chat retries recover committed submissions after conversation %s",
    async (action) => {
        const database = await fixture();
        try {
            const api = database.caller().mira;
            const chat = await api.conversations.create({
                title: "Retry after lifecycle change",
            });
            const input = {
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Committed message",
            };
            const run = await api.conversations.send(input);
            await api.runs.cancel(run);
            const current = await api.conversations.read({ id: chat.id });
            await api.conversations.change({
                id: chat.id,
                version: current.conversation.version,
                action,
            });
            expect(await api.conversations.send(input)).toEqual(run);
            await rejects(
                api.conversations.send({ ...input, text: "Different message" }),
                /already belongs/
            );
            await rejects(
                api.conversations.send({ ...input, requestId: crypto.randomUUID() }),
                /active conversation/
            );
            await rejects(
                database.caller("other").mira.conversations.send(input),
                /active conversation/
            );
        } finally {
            await database.close();
        }
    }
);

test.each(["pause", "delete"])(
    "run claims yield to an uncommitted automation %s",
    async (action) => {
        const database = await fixture();
        try {
            const api = database.caller().mira;
            const automation = await api.automations.create({
                title: "Claim controls",
                prompt: "Inspect",
                kind: "custom",
                schedule: {
                    kind: "once",
                    at: new Date(Date.now() + 60_000).toISOString(),
                },
                budgetSeconds: 60,
            });
            await api.controls.setEnabled({
                key: `automation:${automation.id}`,
                version: 1,
                enabled: true,
                reason: null,
                until: null,
            });
            await database.client`UPDATE mira_automations SET next_run_at=now()-interval '1 second' WHERE id=${automation.id}`;
            expect(await scheduleMiraRuns(database.client)).toBe(1);
            await database.client.begin(async (query) => {
                await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:controls:operator',0))`;
                if (action === "pause")
                    await query`UPDATE mira_switches SET enabled=false,reason='Intentional test pause' WHERE owner='operator' AND key=${`automation:${automation.id}`}`;
                if (action === "delete")
                    await query`UPDATE mira_automations SET deleted_at=now() WHERE id=${automation.id}`;
                expect(
                    await claimMiraRun(database.client, crypto.randomUUID(), "general")
                ).toBeNull();
                const [state] = await query<
                    { state: string }[]
                >`SELECT state FROM mira_runs WHERE automation_id=${automation.id}`;
                expect(state?.state).toBe("queued");
            });
            expect(
                await claimMiraRun(database.client, crypto.randomUUID(), "general")
            ).toBeNull();
            const [state] = await database.client<
                { state: string }[]
            >`SELECT state FROM mira_runs WHERE automation_id=${automation.id}`;
            expect(state?.state).toBe("interrupted");
        } finally {
            await database.close();
        }
    }
);

test("task admission never waits for a chat request lock while owning its conversation", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const chat = await api.conversations.create({ title: "Task request lock order" });
        const saved = await api.tasks.create({ ...task, conversationId: chat.id });
        const requestId = crypto.randomUUID();
        await database.client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:request:operator:${requestId}`},0))`;
            const run = await api.tasks.run({ id: saved.id, version: 1, requestId });
            expect(run.conversationId).toBe(chat.id);
        });
    } finally {
        await database.close();
    }
});

test("conversation paging follows recent activity with stable microsecond cursors", async () => {
    const db = await fixture();
    try {
        const api = db.caller().mira;
        const ids = Array.from({ length: 35 }, () => Bun.randomUUIDv7());
        for (let i = 0; i < ids.length; i++)
            await db.client`INSERT INTO mira_conversations(id,owner,title,updated_at) VALUES (${ids[i]!},'operator',${`Chat ${i}`},'2026-01-01'::timestamptz+${i}*interval '1 microsecond')`;
        await db.client`UPDATE mira_conversations SET updated_at='2026-01-02' WHERE id=${ids[0]!}`;
        const first = await api.conversations.list(page);
        expect(first.rows).toHaveLength(30);
        expect(first.rows[0]?.id).toBe(ids[0]);
        expect(first.nextCursor).not.toBeNull();
        await db.client`UPDATE mira_conversations SET updated_at='2026-01-03' WHERE id=${first.nextCursor!.id}`;
        const second = await api.conversations.list({
            ...page,
            before: first.nextCursor!,
        });
        expect(second.rows).toHaveLength(5);
        expect(new Set([...first.rows, ...second.rows].map((chat) => chat.id)).size).toBe(
            35
        );
        const other = await db
            .caller("other")
            .mira.conversations.list({ ...page, before: first.nextCursor! });
        expect(other.rows).toHaveLength(0);
    } finally {
        await db.close();
    }
});

test("scheduled conversations stay in run history until the operator continues them", async () => {
    const database = await fixture();
    try {
        const api = database.caller().mira;
        const chat = await api.conversations.create({ title: "My ongoing chat" });
        const automation = await api.automations.create({
            title: "Quiet heartbeat",
            prompt: "Read synthetic state only.",
            kind: "custom",
            schedule: { kind: "interval", intervalSeconds: 1800 },
            budgetSeconds: 60,
        });
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            version: 1,
            enabled: true,
            reason: null,
            until: null,
        });
        for (let index = 0; index < 31; index++) {
            await database.client`UPDATE mira_automations SET next_run_at=now()-interval '1 hour' WHERE id=${automation.id}`;
            expect(await scheduleMiraRuns(database.client)).toBe(1);
            const run = await claimMiraRun(
                database.client,
                crypto.randomUUID(),
                "general"
            );
            if (!run) throw new Error("Expected heartbeat run");
            await finishMiraRun(database.client, run, {
                state: "completed",
                text: "No changes.",
                message: null,
            });
        }
        const conversations = await api.conversations.list(page);
        expect(conversations.rows.map((row) => row.id)).toEqual([chat.id]);
        expect(conversations.nextCursor).toBeNull();
        const searched = await api.conversations.list({
            ...page,
            search: "Quiet heartbeat",
        });
        expect(searched.rows).toHaveLength(0);
        const history = await api.runs.list(page);
        expect(history.rows).toHaveLength(30);
        const scheduled = history.rows[0]!;
        expect(scheduled.conversationAvailable).toBe(true);
        const automaticChat = await api.conversations.read({
            id: scheduled.conversationId,
        });
        expect(automaticChat.messages).toHaveLength(2);
        await rejects(
            database
                .caller("other")
                .mira.conversations.read({ id: scheduled.conversationId }),
            /not found/
        );
        await api.conversations.send({
            conversationId: scheduled.conversationId,
            requestId: crypto.randomUUID(),
            text: "Explain this heartbeat result.",
        });
        const promoted = await api.conversations.list(page);
        expect(promoted.rows.map((row) => row.id)).toEqual([
            scheduled.conversationId,
            chat.id,
        ]);
        const run = await claimMiraRun(
            database.client,
            crypto.randomUUID(),
            "foreground"
        );
        if (!run) throw new Error("Expected follow-up run");
        await finishMiraRun(database.client, run, {
            state: "completed",
            text: "Explanation.",
            message: null,
        });
        const read = await api.conversations.read({ id: scheduled.conversationId });
        await api.conversations.change({
            id: scheduled.conversationId,
            version: read.conversation.version,
            action: "archive",
        });
        const archived = await api.conversations.list({ ...page, archived: true });
        expect(archived.rows.map((row) => row.id)).toEqual([scheduled.conversationId]);
    } finally {
        await database.close();
    }
});
