import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { capabilities } from "@homelab/contracts/operations";
import { setMiraEnabled } from "@homelab/mira/data/automations";
import { enqueueTurn } from "@homelab/mira/data/conversations";
import {
    claimMiraRun,
    finishMiraRun,
    renewMiraRun,
    scheduleMiraRuns,
} from "@homelab/mira/data/queue";
import { runMiraTask } from "@homelab/mira/data/taskExecution";
import { reviewTaskRun } from "@homelab/mira/data/taskRecovery";
import { addTaskProgress, saveTask } from "@homelab/mira/data/tasks";
import {
    acknowledgeTaskSteering,
    readTaskSteering,
} from "@homelab/mira/data/taskSteering";

import { executeMiraTurn } from "../../../../mira/src/server/executor/turn";
import { appRouter } from "../api/router";
import { createMiraTextTestTools } from "../testing/miraTools";
import { operationFixture } from "../testing/operations";

const fields = {
    title: "Synthetic ongoing task",
    description: "Continue the existing work",
    status: "in_progress" as const,
    assignee: "mira" as const,
    priority: "normal" as const,
    labels: [],
    dueAt: null,
    completionCriteria: "Verified result",
    conversationId: null,
};

async function fixture() {
    const f = await operationFixture();
    const context = { client: f.client, owner: "operator", actor: "human:operator" };
    const api = appRouter.createCaller({
        operations: f,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    const task = await api.tasks.create(fields);
    const requested = await runMiraTask(context, {
        id: task.id,
        version: 1,
        requestId: crypto.randomUUID(),
        instructions: "",
        reviewedRunId: null,
    });
    const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
    if (!run) throw new Error("Expected explicitly requested work.");
    const update = (
        version: number,
        status: "in_progress" | "blocked" | "done" = "in_progress",
        extra: Partial<typeof fields> = {}
    ) =>
        saveTask(context, {
            ...fields,
            ...extra,
            id: task.id,
            version,
            status,
            conversationId: requested.conversationId,
        });
    const finish = (
        state: "completed" | "interrupted" | "needs_attention" = "completed"
    ) =>
        finishMiraRun(f.client, run, {
            state,
            text: "Existing progress preserved",
            message: null,
        });
    return { ...f, context, api, task, requested, run, update, finish };
}

test("moving a never-started task out of Blocked cannot start task work", async () => {
    const f = await operationFixture();
    try {
        const context = { client: f.client, owner: "operator", actor: "human:operator" };
        const task = await saveTask(context, { ...fields, status: "blocked" });
        await saveTask(context, { ...fields, id: task.id, version: 1 });
        expect(await scheduleMiraRuns(f.client)).toBe(0);
        expect(await claimMiraRun(f.client, crypto.randomUUID(), "general")).toBeNull();
    } finally {
        await f.close();
    }
});

test("unblocking resumes existing work exactly once in its original conversation", async () => {
    const f = await fixture();
    try {
        await f.finish();
        await f.update(2, "blocked");
        await f.update(3);
        await f.update(4, "in_progress", {
            description: "The blocker is resolved; preserve this newer detail.",
        });
        const scheduled = await Promise.all([
            scheduleMiraRuns(f.client),
            scheduleMiraRuns(f.client),
        ]);
        expect(scheduled.reduce((total, value) => total + value, 0)).toBe(1);
        const resumed = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(resumed).toMatchObject({
            taskId: f.task.id,
            conversationId: f.requested.conversationId,
            manual: true,
            taskResumed: true,
        });
        if (!resumed) throw new Error("Expected continued work.");
        expect(
            createMiraTextTestTools(f.client, resumed).some(
                (tool) => tool.name === "mira_task_update"
            )
        ).toBe(true);
        expect(await readTaskSteering(f.client, resumed)).toBeNull();
        await finishMiraRun(f.client, resumed, {
            state: "completed",
            text: "Continued",
            message: null,
        });
        expect(await scheduleMiraRuns(f.client)).toBe(0);
    } finally {
        await f.close();
    }
});

test("live edits and human progress steer only the current owned work lease", async () => {
    const f = await fixture();
    try {
        expect(await readTaskSteering(f.client, f.run)).toBeNull();
        await f.update(2, "in_progress", { description: "New direction" });
        await addTaskProgress(f.context, f.task.id, "Human clarification");
        const edit = await readTaskSteering(f.client, f.run);
        if (!edit) throw new Error("Expected steering input.");
        expect(
            await readTaskSteering(f.client, { ...f.run, owner: "another-owner" })
        ).toBeNull();
        expect(
            await acknowledgeTaskSteering(
                f.client,
                { ...f.run, leaseToken: crypto.randomUUID() },
                edit.id
            )
        ).toBe(false);
        expect(await acknowledgeTaskSteering(f.client, f.run, edit.id)).toBe(true);
        expect(await readTaskSteering(f.client, f.run)).toBeNull();
        await addTaskProgress(
            { ...f.context, actor: "mira:synthetic" },
            f.task.id,
            "Mira progress does not steer itself"
        );
        expect(await readTaskSteering(f.client, f.run)).toBeNull();
        await f.update(3, "in_progress", { completionCriteria: "Updated verification" });
        const newer = await readTaskSteering(f.client, f.run);
        expect(newer?.id).not.toBe(edit.id);
        expect(await acknowledgeTaskSteering(f.client, f.run, edit.id)).toBe(false);
        expect(await readTaskSteering(f.client, f.run)).toEqual(newer);
        expect(await scheduleMiraRuns(f.client)).toBe(0);
    } finally {
        await f.close();
    }
});

test("Blocked fences new tools immediately and a quick unblock waits for the old run to stop", async () => {
    const f = await fixture();
    try {
        await f.update(2, "blocked");
        const tool = createMiraTextTestTools(f.client, f.run).find(
            (row) => row.name === "mira_task_read"
        )!;
        const result = JSON.parse(
            await tool.execute({ id: f.task.id }, new AbortController().signal, {
                callId: "blocked-read",
                threadId: "test",
                turnId: "test",
            })
        ) as { ok: boolean };
        expect(result.ok).toBe(false);
        await f.update(3);
        expect(await scheduleMiraRuns(f.client)).toBe(0);
        expect(await renewMiraRun(f.client, f.run)).toBe(false);
        expect(await readTaskSteering(f.client, f.run)).toBeNull();
        await f.finish("interrupted");
        expect(await scheduleMiraRuns(f.client)).toBe(1);
        const resumed = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(resumed?.taskResumed).toBe(true);
        if (!resumed) throw new Error("Expected replacement work after stop.");
        expect(await renewMiraRun(f.client, resumed)).toBe(true);
    } finally {
        await f.close();
    }
});

test("an unacknowledged edit at the end of work continues once instead of becoming only a report", async () => {
    const f = await fixture();
    try {
        await f.update(2, "in_progress", {
            description: "Additional requirement during the final reply",
        });
        await f.finish();
        expect(await scheduleMiraRuns(f.client)).toBe(1);
        const resumed = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(resumed).toMatchObject({
            taskResumed: true,
            conversationId: f.run.conversationId,
        });
        if (!resumed) throw new Error("Expected late-edit continuation.");
        await finishMiraRun(f.client, resumed, {
            state: "completed",
            text: "Updated",
            message: null,
        });
        expect(await scheduleMiraRuns(f.client)).toBe(0);
    } finally {
        await f.close();
    }
});

test("a fully acknowledged edit does not queue duplicate work after completion", async () => {
    const f = await fixture();
    try {
        await f.update(2);
        const edit = await readTaskSteering(f.client, f.run);
        if (!edit) throw new Error("Expected edit.");
        await acknowledgeTaskSteering(f.client, f.run, edit.id);
        await f.finish();
        expect(await scheduleMiraRuns(f.client)).toBe(0);
    } finally {
        await f.close();
    }
});

test("unblocking preserves uncertainty review and the automatic-work pause", async () => {
    const f = await fixture();
    try {
        await f.finish("needs_attention");
        await f.update(2, "blocked");
        await f.update(3);
        expect(await scheduleMiraRuns(f.client)).toBe(0);
        await reviewTaskRun(f.context, { id: f.task.id, version: 4, runId: f.run.id });
        const controls = await f.api.controls.list();
        const autonomy = controls.find((row) => row.key === "autonomy")!;
        await f.api.controls.setEnabled({
            key: "autonomy",
            version: autonomy.version,
            enabled: false,
            reason: "Pause automatic work",
            until: null,
        });
        expect(await scheduleMiraRuns(f.client)).toBe(0);
        await f.api.controls.setEnabled({
            key: "autonomy",
            version: autonomy.version + 1,
            enabled: true,
            reason: null,
            until: null,
        });
        expect(await scheduleMiraRuns(f.client)).toBe(1);
    } finally {
        await f.close();
    }
});

test.each(["done", "reassigned", "archived", "expired"])(
    "a pending unblock cannot override %s",
    async (action) => {
        const f = await fixture();
        try {
            await f.finish();
            await f.update(2, "blocked");
            await f.update(3);
            if (action === "done") await f.update(4, "done");
            if (action === "reassigned")
                await saveTask(f.context, {
                    ...fields,
                    id: f.task.id,
                    version: 4,
                    assignee: "operator",
                    conversationId: f.requested.conversationId,
                });
            if (action === "archived")
                await f.client`UPDATE mira_conversations SET archived_at=now() WHERE id=${f.run.conversationId}`;
            if (action === "expired")
                await f.client`UPDATE mira_audit SET created_at=now()-interval '2 days' WHERE target=${f.task.id}`;
            expect(await scheduleMiraRuns(f.client)).toBe(0);
        } finally {
            await f.close();
        }
    }
);

test.each(["steer-ok", "steer-error", "wait"])(
    "executor delivers task steering or a board pause through the active runtime: %s",
    async (mode) => {
        const f = await fixture();
        const directory = await mkdtemp(path.join(tmpdir(), "mira-task-steering-"));
        const stopping = new AbortController();
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
                `#!/usr/bin/env bun
process.argv=[process.argv[0],${JSON.stringify(child)},${JSON.stringify(mode)},${JSON.stringify(home)}];
await import(${JSON.stringify(child)});
`
            );
            await chmod(command, 0o700);
            execution = executeMiraTurn(
                f.client,
                { command, codexHome: home, workspace, model: "synthetic" },
                f.run,
                stopping.signal
            );
            let started = false;
            for (let attempt = 0; attempt < 200 && !started; attempt++) {
                const [row] = await f.client<
                    { started: boolean }[]
                >`SELECT provider_turn IS NOT NULL AS started FROM mira_runs WHERE id=${f.run.id}`;
                started = row?.started === true;
                if (!started) await delay(10);
            }
            expect(started).toBe(true);
            await f.update(2, mode === "wait" ? "blocked" : "in_progress", {
                description: "Revised by the operator while the provider is active",
            });
            await execution;
            const history = await f.api.conversations.read({ id: f.run.conversationId });
            expect(history.run?.state).toBe(
                (
                    {
                        "steer-ok": "completed",
                        wait: "interrupted",
                        "steer-error": "needs_attention",
                    } as Record<string, "completed" | "interrupted" | "needs_attention">
                )[mode]
            );
            if (mode === "steer-ok") {
                expect(history.messages.at(-1)?.content).toContain(
                    `The operator updated task ${f.task.id}`
                );
                expect(await scheduleMiraRuns(f.client)).toBe(0);
            } else if (mode === "steer-error") {
                expect(await scheduleMiraRuns(f.client)).toBe(0);
            }
        } finally {
            stopping.abort();
            await Promise.allSettled([execution]);
            await f.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
    15_000
);

test("adopted conversation history does not authorize starting a new task", async () => {
    const f = await operationFixture();
    try {
        const context = { client: f.client, owner: "operator", actor: "human:operator" };
        const api = appRouter.createCaller({
            operations: f,
            principal: { kind: "human", id: "operator", capabilities },
        }).mira;
        const chat = await api.conversations.create({
            title: "Earlier unrelated conversation",
        });
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "An ordinary previous question",
        });
        const earlier = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        if (!earlier) throw new Error("Expected ordinary conversation.");
        await finishMiraRun(f.client, earlier, {
            state: "completed",
            text: "Answered",
            message: null,
        });
        const task = await saveTask(context, {
            ...fields,
            status: "blocked",
            conversationId: chat.id,
        });
        await saveTask(context, {
            ...fields,
            id: task.id,
            version: 1,
            conversationId: chat.id,
        });
        expect(await scheduleMiraRuns(f.client)).toBe(0);
        expect(
            await claimMiraRun(f.client, crypto.randomUUID(), "foreground")
        ).toBeNull();
    } finally {
        await f.close();
    }
});

test.each(["paused", "capacity", "uncertain", "admission"])(
    "a blocked continuation batch cannot starve another owner: %s",
    async (mode) => {
        const f = await operationFixture();
        const blocked = {
            client: f.client,
            owner: "blocked-owner",
            actor: "human:blocked-owner",
        };
        const ready = {
            client: f.client,
            owner: "ready-owner",
            actor: "human:ready-owner",
        };
        const waiting: { id: string; runId: string }[] = [];
        const release = Promise.withResolvers<void>();
        let held: Promise<unknown> = Promise.resolve();
        try {
            let readyTask = "";
            for (let index = 0; index < 21; index++) {
                const context = index < 20 ? blocked : ready;
                const task = await saveTask(context, fields);
                const requested = await runMiraTask(context, {
                    id: task.id,
                    version: 1,
                    requestId: crypto.randomUUID(),
                    instructions: "",
                    reviewedRunId: null,
                });
                const run = await claimMiraRun(
                    f.client,
                    crypto.randomUUID(),
                    "foreground"
                );
                if (!run) throw new Error("Expected initial task work.");
                await finishMiraRun(f.client, run, {
                    state:
                        index < 20 && mode === "uncertain"
                            ? "needs_attention"
                            : "completed",
                    text: "Recorded initial work",
                    message: null,
                });
                await saveTask(context, {
                    ...fields,
                    id: task.id,
                    version: 2,
                    conversationId: requested.conversationId,
                    status: "blocked",
                });
                await saveTask(context, {
                    ...fields,
                    id: task.id,
                    version: 3,
                    conversationId: requested.conversationId,
                });
                if (index < 20) waiting.push({ id: task.id, runId: run.id });
                else readyTask = task.id;
            }
            if (mode === "paused")
                await setMiraEnabled(blocked, {
                    key: "autonomy",
                    version: 1,
                    enabled: false,
                    reason: "Deliberate pause",
                    until: null,
                });
            if (mode === "capacity")
                await f.client.begin(async (query) => {
                    for (let index = 0; index < 32; index++) {
                        const conversationId = crypto.randomUUID();
                        await query`INSERT INTO mira_conversations(id,owner,title) VALUES (${conversationId},${blocked.owner},'Other queued work')`;
                        await enqueueTurn(query, blocked, {
                            conversationId,
                            requestId: crypto.randomUUID(),
                            text: "Existing queue entry",
                            attachmentIds: [],
                        });
                    }
                });
            if (mode === "admission") {
                const locked = Promise.withResolvers<void>();
                held = f.client.begin(async (query) => {
                    for (const task of waiting)
                        await query`SELECT pg_advisory_xact_lock(hashtextextended(${`mira:task:${blocked.owner}:${task.id}`},0))`;
                    locked.resolve();
                    await release.promise;
                });
                await locked.promise;
            }
            expect(await scheduleMiraRuns(f.client)).toBe(0);
            expect(await scheduleMiraRuns(f.client)).toBe(1);
            const queued = await f.client<
                { owner: string }[]
            >`SELECT owner FROM mira_runs WHERE task_id=${readyTask} AND state='queued'`;
            expect(queued.map((row) => row.owner)).toEqual([ready.owner]);
            if (mode === "paused")
                await setMiraEnabled(blocked, {
                    key: "autonomy",
                    version: 2,
                    enabled: true,
                    reason: null,
                    until: null,
                });
            if (mode === "capacity")
                await f.client`UPDATE mira_runs SET state='interrupted' WHERE owner=${blocked.owner} AND state='queued'`;
            if (mode === "uncertain")
                for (const task of waiting)
                    await reviewTaskRun(blocked, {
                        id: task.id,
                        runId: task.runId,
                        version: 4,
                    });
            release.resolve();
            await held;
            expect(await scheduleMiraRuns(f.client)).toBe(20);
        } finally {
            release.resolve();
            await held;
            await f.close();
        }
    },
    15_000
);
