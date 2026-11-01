import { expect, test } from "bun:test";

import { setMiraEnabled } from "@homelab/mira/data/automations";
import { cancelRun, createConversation } from "@homelab/mira/data/conversations";
import { claimMiraRun, finishMiraRun, scheduleMiraRuns } from "@homelab/mira/data/queue";
import { runMiraTask } from "@homelab/mira/data/taskExecution";
import { readTask, saveTask } from "@homelab/mira/data/tasks";
import { readTaskSteering } from "@homelab/mira/data/taskSteering";

import { createMiraTextTestTools } from "../testing/miraTools";
import { operationFixture } from "../testing/operations";

const fields = {
    title: "Synthetic automatic task",
    description: "Use the latest requirements",
    status: "todo" as const,
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
    const update = async (id: string, patch: Partial<Parameters<typeof saveTask>[1]>) => {
        const {
            createdAt: _created,
            updatedAt: _updated,
            ...current
        } = await readTask(context, id);
        return saveTask(context, { ...current, ...patch });
    };
    return { ...f, context, update };
}

test("manual is the default; an opted-in task starts once on the general worker", async () => {
    const f = await fixture();
    try {
        const manual = await saveTask(f.context, fields);
        const savedManual = await readTask(f.context, manual.id);
        expect(savedManual.autoStart).toBe(false);
        expect(await scheduleMiraRuns(f.client)).toBe(0);
        const automatic = await saveTask(f.context, { ...fields, autoStart: true });
        const counts = await Promise.all([
            scheduleMiraRuns(f.client),
            scheduleMiraRuns(f.client),
        ]);
        expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
        expect(
            await claimMiraRun(f.client, crypto.randomUUID(), "foreground")
        ).toBeNull();
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "general");
        if (!run) throw new Error("Expected automatic task work");
        expect(run).toMatchObject({
            taskId: automatic.id,
            taskResumed: true,
            manual: true,
        });
        const savedAutomatic = await readTask(f.context, automatic.id);
        expect(savedAutomatic.conversationId).toBe(run.conversationId);
        await finishMiraRun(f.client, run, {
            state: "completed",
            text: "Verified",
            message: null,
        });
        await f.update(automatic.id, {
            description: "A later edit alone must not restart completed work.",
        });
        expect(await scheduleMiraRuns(f.client)).toBe(0);
        const denied = await readTask(
            { ...f.context, owner: "other" },
            automatic.id
        ).catch((error: unknown) => error);
        expect(denied).toBeInstanceOf(Error);
    } finally {
        await f.close();
    }
});

test.each(["blocked", "done", "operator"] as const)(
    "automatic start waits until the operator makes the task ready: %s",
    async (state) => {
        const f = await fixture();
        try {
            const task = await saveTask(f.context, {
                ...fields,
                autoStart: true,
                ...(state === "operator" ? { assignee: "operator" } : { status: state }),
            });
            expect(await scheduleMiraRuns(f.client)).toBe(0);
            await f.update(task.id, { status: "in_progress", assignee: "mira" });
            expect(await scheduleMiraRuns(f.client)).toBe(1);
            const run = await claimMiraRun(f.client, crypto.randomUUID(), "general");
            expect(run?.taskId).toBe(task.id);
        } finally {
            await f.close();
        }
    }
);

test("automatic start reuses the conversation, provider settings, steering and unblock flow", async () => {
    const f = await fixture();
    try {
        const chat = await createConversation(f.context, "Existing task context");
        await f.client`UPDATE mira_conversations SET settings=settings || '{"model":"syn:large:text","executionTarget":"main"}'::jsonb WHERE id=${chat.id}`;
        const task = await saveTask(f.context, {
            ...fields,
            autoStart: true,
            conversationId: chat.id,
        });
        expect(await scheduleMiraRuns(f.client)).toBe(1);
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "general");
        if (!run) throw new Error("Expected work");
        expect(run).toMatchObject({ conversationId: chat.id, executionTarget: "main" });
        const [saved] = await f.client<
            { model: string }[]
        >`SELECT settings->>'model' AS model FROM mira_runs WHERE id=${run.id}`;
        expect(saved?.model).toBe("syn:large:text");
        await f.update(task.id, { description: "New direction during work" });
        expect(await readTaskSteering(f.client, run)).not.toBeNull();
        await f.update(task.id, { status: "blocked" });
        await cancelRun(f.context, run.id);
        await finishMiraRun(f.client, run, {
            state: "interrupted",
            text: "Blocked",
            message: null,
        });
        await f.update(task.id, { status: "in_progress" });
        expect(await scheduleMiraRuns(f.client)).toBe(1);
        const next = await claimMiraRun(f.client, crypto.randomUUID(), "general");
        expect(next?.conversationId).toBe(chat.id);
        expect(await scheduleMiraRuns(f.client)).toBe(0);
    } finally {
        await f.close();
    }
});

test("global pause defers automatic starts and Run mode cancels an unclaimed automatic start", async () => {
    const f = await fixture();
    try {
        const task = await saveTask(f.context, { ...fields, autoStart: true });
        await setMiraEnabled(f.context, {
            key: "autonomy",
            enabled: false,
            reason: "Maintenance",
            until: null,
            version: 1,
        });
        expect(await scheduleMiraRuns(f.client)).toBe(0);
        await setMiraEnabled(f.context, {
            key: "autonomy",
            enabled: true,
            reason: null,
            until: null,
            version: 2,
        });
        expect(await scheduleMiraRuns(f.client)).toBe(1);
        await setMiraEnabled(f.context, {
            key: "autonomy",
            enabled: false,
            reason: "Pause queued work",
            until: null,
            version: 3,
        });
        expect(await claimMiraRun(f.client, crypto.randomUUID(), "general")).toBeNull();
        await f.update(task.id, { autoStart: false });
        await setMiraEnabled(f.context, {
            key: "autonomy",
            enabled: true,
            reason: null,
            until: null,
            version: 4,
        });
        expect(await claimMiraRun(f.client, crypto.randomUUID(), "general")).toBeNull();
        expect(await scheduleMiraRuns(f.client)).toBe(0);
        const [run] = await f.client<
            { state: string }[]
        >`SELECT state FROM mira_runs WHERE task_id=${task.id}`;
        expect(run?.state).toBe("interrupted");
    } finally {
        await f.close();
    }
});

test("an explicit Run wins admission without an automatic duplicate", async () => {
    const f = await fixture();
    try {
        const task = await saveTask(f.context, { ...fields, autoStart: true });
        const run = await runMiraTask(f.context, {
            id: task.id,
            version: 1,
            requestId: crypto.randomUUID(),
            instructions: "",
            reviewedRunId: null,
        });
        expect(await scheduleMiraRuns(f.client)).toBe(0);
        const claim = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(claim?.id).toBe(run.id);
        await cancelRun(f.context, run.id);
        if (!claim) throw new Error("Expected manual work");
        await finishMiraRun(f.client, claim, {
            state: "interrupted",
            text: "Stopped",
            message: null,
        });
        expect(await scheduleMiraRuns(f.client)).toBe(0);
    } finally {
        await f.close();
    }
});

test("reenabling automatic start cannot revive a revoked queued request", async () => {
    const f = await fixture();
    try {
        const task = await saveTask(f.context, { ...fields, autoStart: true });
        expect(await scheduleMiraRuns(f.client)).toBe(1);
        await f.update(task.id, { autoStart: false });
        await f.update(task.id, { autoStart: true });
        expect(await claimMiraRun(f.client, crypto.randomUUID(), "general")).toBeNull();
        expect(await scheduleMiraRuns(f.client)).toBe(1);
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "general");
        expect(run?.taskId).toBe(task.id);
        const rows = await f.client<
            { state: string }[]
        >`SELECT state FROM mira_runs WHERE task_id=${task.id} ORDER BY id`;
        expect(rows.map((row) => row.state)).toEqual(["interrupted", "running"]);
    } finally {
        await f.close();
    }
});

test("enabling automatic start during queued Run does not add another execution", async () => {
    const f = await fixture();
    try {
        const task = await saveTask(f.context, fields);
        await runMiraTask(f.context, {
            id: task.id,
            version: 1,
            requestId: crypto.randomUUID(),
            instructions: "",
            reviewedRunId: null,
        });
        await f.update(task.id, { autoStart: true });
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        if (!run) throw new Error("Expected existing work");
        await finishMiraRun(f.client, run, {
            state: "completed",
            text: "Verified",
            message: null,
        });
        expect(await scheduleMiraRuns(f.client)).toBe(0);
    } finally {
        await f.close();
    }
});

test("Mira cannot enable automatic start or create its own automatic start request", async () => {
    const f = await fixture();
    try {
        await saveTask(f.context, { ...fields, autoStart: true });
        await scheduleMiraRuns(f.client);
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "general");
        if (!run) throw new Error("Expected work");
        const tool = createMiraTextTestTools(f.client, run).find(
            (row) => row.name === "mira_task_create"
        )!;
        const result = JSON.parse(
            await tool.execute(
                { ...fields, autoStart: true },
                new AbortController().signal,
                { callId: "self-start", threadId: "test", turnId: "test" }
            )
        ) as { ok: boolean };
        expect(result.ok).toBe(false);
        const denied = await saveTask(
            {
                ...f.context,
                actor: `mira:${run.id}`,
                run: { id: run.id, leaseToken: run.leaseToken },
            },
            { ...fields, autoStart: true }
        ).catch((error: unknown) => error);
        expect(denied).toBeInstanceOf(Error);
        await saveTask(
            {
                ...f.context,
                actor: `mira:${run.id}`,
                run: { id: run.id, leaseToken: run.leaseToken },
            },
            { ...fields }
        );
        const [requests] = await f.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_audit WHERE action='task.auto_start_requested'`;
        expect(requests?.count).toBe(1);
    } finally {
        await f.close();
    }
});

test.each(["uncertain", "archived", "expired"] as const)(
    "automatic start preserves recovery and lifecycle gates: %s",
    async (state) => {
        const f = await fixture();
        try {
            const task = await saveTask(f.context, { ...fields });
            const requested = await runMiraTask(f.context, {
                id: task.id,
                version: 1,
                requestId: crypto.randomUUID(),
                instructions: "",
                reviewedRunId: null,
            });
            const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
            if (!run) throw new Error("Expected manual work");
            await finishMiraRun(f.client, run, {
                state: state === "uncertain" ? "needs_attention" : "completed",
                text: "Observed result",
                message: null,
            });
            await f.update(task.id, { autoStart: true });
            if (state === "archived")
                await f.client`UPDATE mira_conversations SET archived_at=now() WHERE id=${requested.conversationId}`;
            if (state === "expired")
                await f.client`UPDATE mira_audit SET created_at=now()-interval '2 days' WHERE action='task.auto_start_requested'`;
            expect(await scheduleMiraRuns(f.client)).toBe(0);
        } finally {
            await f.close();
        }
    }
);
