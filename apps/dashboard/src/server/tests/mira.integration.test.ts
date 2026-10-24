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
