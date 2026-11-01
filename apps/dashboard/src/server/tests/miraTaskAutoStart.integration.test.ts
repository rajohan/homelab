import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";
import { setMiraEnabled } from "@homelab/mira/data/automations";
import { cancelRun, createConversation } from "@homelab/mira/data/conversations";
import { claimMiraRun, finishMiraRun, scheduleMiraRuns } from "@homelab/mira/data/queue";
import { runMiraTask } from "@homelab/mira/data/taskExecution";
import { readTask, saveTask } from "@homelab/mira/data/tasks";
import { readTaskSteering } from "@homelab/mira/data/taskSteering";

import { appRouter } from "../api/router";
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
        const api = (owner: string) =>
            appRouter.createCaller({
                operations: f,
                principal: { kind: "human", id: owner, capabilities },
            }).mira;
        const savedAutomatic = await api("operator").tasks.read({ id: automatic.id });
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
        expect(await claimMiraRun(f.client, crypto.randomUUID(), "general")).toBeNull();
        expect(await scheduleMiraRuns(f.client)).toBe(0);
        const [run] = await f.client<
            { state: string }[]
        >`SELECT state FROM mira_runs WHERE task_id=${task.id}`;
        expect(run?.state).toBe("interrupted");
        const current = await readTask(f.context, task.id);
        const manual = await runMiraTask(f.context, {
            id: task.id,
            version: current.version,
            requestId: crypto.randomUUID(),
            instructions: "Run while automatic work remains paused",
            reviewedRunId: null,
        });
        const claimed = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(claimed?.id).toBe(manual.id);
    } finally {
        await f.close();
    }
});

test.each(["queued", "running"] as const)(
    "automatic start waits behind a %s assessment without losing the request",
    async (state) => {
        const f = await fixture();
        try {
            const api = appRouter.createCaller({
                operations: f,
                principal: { kind: "human", id: "operator", capabilities },
            }).mira;
            const automation = await api.automations.create({
                title: "Task assessment",
                prompt: "Assess changes without performing the task.",
                kind: "custom",
                schedule: { kind: "event", event: "task_changed" },
                budgetSeconds: 60,
            });
            await api.controls.setEnabled({
                key: `automation:${automation.id}`,
                enabled: true,
                version: 1,
                reason: null,
                until: null,
            });
            const task = await saveTask(f.context, fields);
            expect(await scheduleMiraRuns(f.client, new Date(Date.now() + 6000))).toBe(1);
            let assessment =
                state === "running"
                    ? await claimMiraRun(f.client, crypto.randomUUID(), "general")
                    : null;
            await f.update(task.id, { autoStart: true });
            expect(await scheduleMiraRuns(f.client)).toBe(0);
            assessment ??= await claimMiraRun(f.client, crypto.randomUUID(), "general");
            if (!assessment) throw new Error("Expected assessment");
            expect(assessment.manual).toBe(false);
            await finishMiraRun(f.client, assessment, {
                state: "completed",
                text: "Assessment complete",
                message: null,
            });
            expect(await scheduleMiraRuns(f.client)).toBe(1);
            const run = await claimMiraRun(f.client, crypto.randomUUID(), "general");
            expect(run).toMatchObject({
                taskId: task.id,
                manual: true,
                taskResumed: true,
            });
        } finally {
            await f.close();
        }
    }
);

test.each(["blocked", "done", "operator"] as const)(
    "a queued automatic start is replaced after the task becomes ready again: %s",
    async (state) => {
        const f = await fixture();
        try {
            const task = await saveTask(f.context, { ...fields, autoStart: true });
            expect(await scheduleMiraRuns(f.client)).toBe(1);
            await f.update(
                task.id,
                state === "operator" ? { assignee: "operator" } : { status: state }
            );
            await f.update(task.id, { status: "todo", assignee: "mira" });
            const [requests] = await f.client<{ total: number }[]>`
                SELECT count(*)::int AS total FROM mira_audit
                WHERE target=${task.id} AND action='task.auto_start_requested'`;
            expect(requests?.total).toBe(2);
            expect(
                await claimMiraRun(f.client, crypto.randomUUID(), "general")
            ).toBeNull();
            expect(await scheduleMiraRuns(f.client)).toBe(1);
            const run = await claimMiraRun(f.client, crypto.randomUUID(), "general");
            expect(run?.taskId).toBe(task.id);
            const history = await f.client<{ state: string }[]>`
                SELECT state FROM mira_runs WHERE task_id=${task.id} ORDER BY id`;
            expect(history.map((row) => row.state)).toEqual(["interrupted", "running"]);
        } finally {
            await f.close();
        }
    }
);

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

test("mode revocation does not deadlock a concurrent claim or partly save the task", async () => {
    const f = await fixture();
    try {
        const task = await saveTask(f.context, { ...fields, autoStart: true });
        expect(await scheduleMiraRuns(f.client)).toBe(1);
        await f.client.begin(async (query) => {
            await query`SELECT pg_advisory_xact_lock(hashtextextended('homelab:mira:claim',0))`;
            const result = await f
                .update(task.id, { autoStart: false })
                .catch((error: unknown) => error);
            expect(result).toBeInstanceOf(Error);
            expect((result as Error).message).toContain("Task admission is busy");
            const current = await readTask(f.context, task.id);
            expect(current.autoStart).toBe(true);
        });
        await f.update(task.id, { autoStart: false });
        const [run] = await f.client<{ state: string; messageState: string }[]>`
            SELECT r.state,m.state AS "messageState" FROM mira_runs r
            JOIN mira_messages m ON m.id=r.assistant_message_id WHERE r.task_id=${task.id}`;
        expect(run).toEqual({ state: "interrupted", messageState: "interrupted" });
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

test.each([false, true])(
    "changing start mode during automatic work does not request a second run: reenable %s",
    async (reenable) => {
        const f = await fixture();
        try {
            const task = await saveTask(f.context, { ...fields, autoStart: true });
            await scheduleMiraRuns(f.client);
            const run = await claimMiraRun(f.client, crypto.randomUUID(), "general");
            if (!run) throw new Error("Expected automatic work");
            await f.update(task.id, { autoStart: false });
            if (reenable) await f.update(task.id, { autoStart: true });
            expect(await readTaskSteering(f.client, run)).toBeNull();
            await finishMiraRun(f.client, run, {
                state: "completed",
                text: "Finished existing work",
                message: null,
            });
            expect(await scheduleMiraRuns(f.client)).toBe(0);
        } finally {
            await f.close();
        }
    }
);

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
