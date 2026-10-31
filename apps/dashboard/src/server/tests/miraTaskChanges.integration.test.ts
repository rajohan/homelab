import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";
import type { MiraQuery } from "@homelab/mira/data/context";
import { claimMiraRun, finishMiraRun, scheduleMiraRuns } from "@homelab/mira/data/queue";
import { currentTaskChange, pendingTaskChanges } from "@homelab/mira/data/taskChanges";
import { runMiraTask } from "@homelab/mira/data/taskExecution";
import { addTaskProgress, readTask } from "@homelab/mira/data/tasks";

import { appRouter } from "../api/router";
import { createMiraTextTestTools } from "../testing/miraTools";
import { operationFixture } from "../testing/operations";

const taskFields = {
    title: "Synthetic board task",
    description: "Assess changes without doing the work.",
    status: "todo" as const,
    assignee: "mira" as const,
    priority: "normal" as const,
    labels: [],
    dueAt: null,
    completionCriteria: "Explicitly started work is verified.",
    conversationId: null,
};
const afterQuiet = () => new Date(Date.now() + 6000);
async function fixture() {
    const f = await operationFixture();
    const caller = (id = "operator") =>
        appRouter.createCaller({
            operations: f,
            principal: { kind: "human", id, capabilities },
        }).mira;
    const api = caller();
    const automation = await api.automations.create({
        title: "Task changes",
        prompt: "Assess the latest task without executing it.",
        kind: "custom",
        schedule: { kind: "event", event: "task_changed" },
        budgetSeconds: 60,
    });
    const toggle = async (key: string, enabled: boolean) => {
        const controls = await api.controls.list();
        const control = controls.find((row) => row.key === key)!;
        await api.controls.setEnabled({
            key,
            enabled,
            version: control.version,
            reason: enabled ? null : "Intentional pause",
            until: null,
        });
    };
    await toggle(`automation:${automation.id}`, true);
    return { ...f, api, caller, automation, toggle };
}

test("task creation and rapid edits coalesce into one read/report-only assessment", async () => {
    const f = await fixture();
    try {
        const task = await f.api.tasks.create(taskFields);
        expect(await scheduleMiraRuns(f.client)).toBe(0);
        await f.api.tasks.update({
            ...taskFields,
            id: task.id,
            version: 1,
            title: "Updated task",
            status: "in_progress",
        });
        await f.api.tasks.update({
            ...taskFields,
            id: task.id,
            version: 2,
            title: "Latest task",
            status: "done",
        });
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(1);
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(0);
        expect(
            await claimMiraRun(f.client, crypto.randomUUID(), "foreground")
        ).toBeNull();
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "general");
        expect(run).toMatchObject({
            taskId: task.id,
            manual: false,
            taskAssessment: true,
        });
        if (!run) throw new Error("Expected assessment.");
        const tools = createMiraTextTestTools(f.client, run);
        expect(tools.map((tool) => tool.name).toSorted()).toEqual([
            "mira_controls_list",
            "mira_report_create",
            "mira_reports_list",
            "mira_runs_list",
            "mira_task_progress_list",
            "mira_task_read",
            "mira_tasks_list",
        ]);
        const invoke = async (name: string, input: unknown) =>
            JSON.parse(
                await tools
                    .find((tool) => tool.name === name)!
                    .execute(input, new AbortController().signal, {
                        callId: crypto.randomUUID(),
                        threadId: "test",
                        turnId: "test",
                    })
            ) as { ok: boolean; result?: unknown };
        expect(await invoke("mira_task_read", { id: task.id })).toMatchObject({
            ok: true,
            result: { title: "Latest task", status: "done" },
        });
        expect(
            await invoke("mira_report_create", {
                title: "Task assessment",
                kind: "task",
                markdown: "The operator marked this task done. No work was executed.",
                taskId: task.id,
            })
        ).toMatchObject({ ok: true });
        await finishMiraRun(f.client, run, {
            state: "completed",
            text: "Assessment complete.",
            message: null,
        });
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(0);
        const saved = await readTask(
            { client: f.client, owner: "operator", actor: "human:operator" },
            task.id
        );
        expect(saved.version).toBe(3);
        const [count] = await f.client<
            { total: number }[]
        >`SELECT count(*)::int AS total FROM mira_events WHERE kind='task_changed'`;
        expect(count?.total).toBe(1);
    } finally {
        await f.close();
    }
});

test("queued assessments are superseded by newer human changes and do not replay old edits", async () => {
    const f = await fixture();
    try {
        const task = await f.api.tasks.create(taskFields);
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(1);
        await f.api.tasks.update({
            ...taskFields,
            id: task.id,
            version: 1,
            priority: "high",
        });
        expect(await claimMiraRun(f.client, crypto.randomUUID(), "general")).toBeNull();
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(1);
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "general");
        expect(run?.taskAssessment).toBe(true);
        if (!run) throw new Error("Expected latest assessment.");
        await finishMiraRun(f.client, run, {
            state: "completed",
            text: "Reviewed.",
            message: null,
        });
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(0);
        const history = await f.api.runs.list({ search: "", archived: false });
        expect(history.rows).toHaveLength(2);
    } finally {
        await f.close();
    }
});

test.each(["autonomy", "automation"] as const)(
    "task changes during an intentional %s pause are not replayed",
    async (scope) => {
        const f = await fixture();
        try {
            const key =
                scope === "autonomy" ? "autonomy" : `automation:${f.automation.id}`;
            await f.toggle(key, false);
            const task = await f.api.tasks.create(taskFields);
            await f.toggle(key, true);
            expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(0);
            await f.api.tasks.update({
                ...taskFields,
                id: task.id,
                version: 1,
                status: "blocked",
            });
            expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(1);
        } finally {
            await f.close();
        }
    }
);

test("Mira progress and reports cannot trigger themselves; human progress can", async () => {
    const f = await fixture();
    try {
        const task = await f.api.tasks.create(taskFields);
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(1);
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "general");
        if (!run) throw new Error("Expected initial assessment.");
        await finishMiraRun(f.client, run, {
            state: "completed",
            text: "Reviewed.",
            message: null,
        });
        await addTaskProgress(
            { client: f.client, owner: "operator", actor: "mira:synthetic" },
            task.id,
            "Synthetic agent progress."
        );
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(0);
        await addTaskProgress(
            { client: f.client, owner: "operator", actor: "human:operator" },
            task.id,
            "Human follow-up."
        );
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(1);
    } finally {
        await f.close();
    }
});

test("task assessments respect owner isolation, deletion and the one-day recovery window", async () => {
    const f = await fixture();
    try {
        const other = await f.caller("other").tasks.create(taskFields);
        const deleted = await f.api.tasks.create(taskFields);
        await f.api.tasks.delete({ id: deleted.id, version: 1 });
        const old = await f.api.tasks.create(taskFields);
        await f.client`UPDATE mira_audit SET created_at=now()-interval '2 days' WHERE target=${old.id}`;
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(0);
        const own = await f.api.tasks.create(taskFields);
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(1);
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "general");
        if (!run) throw new Error("Expected own assessment.");
        const read = createMiraTextTestTools(f.client, run).find(
            (tool) => tool.name === "mira_task_read"
        )!;
        const result = JSON.parse(
            await read.execute({ id: other.id }, new AbortController().signal, {
                callId: "foreign",
                threadId: "test",
                turnId: "test",
            })
        ) as { ok: boolean };
        expect(result.ok).toBe(false);
        expect(run.taskId).toBe(own.id);
    } finally {
        await f.close();
    }
});

test("assessments wait for explicit task work and cannot overlap with Run", async () => {
    const f = await fixture();
    try {
        const task = await f.api.tasks.create(taskFields);
        const context = { client: f.client, owner: "operator", actor: "human:operator" };
        const explicit = await runMiraTask(context, {
            id: task.id,
            version: 1,
            requestId: crypto.randomUUID(),
            instructions: "",
            reviewedRunId: null,
        });
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(0);
        const manual = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(manual).toMatchObject({ id: explicit.id, manual: true });
        if (!manual) throw new Error("Expected explicit task run.");
        expect(manual.taskAssessment).not.toBe(true);
        await finishMiraRun(f.client, manual, {
            state: "completed",
            text: "Explicit task work finished.",
            message: null,
        });
        expect(await scheduleMiraRuns(f.client, new Date(Date.now() + 40_000))).toBe(1);
        const assessment = await claimMiraRun(f.client, crypto.randomUUID(), "general");
        expect(assessment?.taskAssessment).toBe(true);
        if (!assessment) throw new Error("Expected deferred assessment.");
        const blocked = await runMiraTask(context, {
            id: task.id,
            version: 2,
            requestId: crypto.randomUUID(),
            instructions: "",
            reviewedRunId: null,
        }).catch((error: unknown) => error);
        expect(blocked).toBeInstanceOf(Error);
        expect((blocked as Error).message).toContain(
            "Stop or finish the current task run"
        );
        await finishMiraRun(f.client, assessment, {
            state: "completed",
            text: "Reviewed without executing the task.",
            message: null,
        });
        expect(await scheduleMiraRuns(f.client, new Date(Date.now() + 80_000))).toBe(0);
        const saved = await readTask(context, task.id);
        expect(saved.status).toBe("todo");
    } finally {
        await f.close();
    }
});

test("pausing an assessment after dispatch prevents its queued run from claiming", async () => {
    const f = await fixture();
    try {
        await f.api.tasks.create(taskFields);
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(1);
        await f.toggle(`automation:${f.automation.id}`, false);
        expect(await claimMiraRun(f.client, crypto.randomUUID(), "general")).toBeNull();
        await f.toggle(`automation:${f.automation.id}`, true);
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(0);
    } finally {
        await f.close();
    }
});

test("assessments that expire while queued cannot start after the one-day window", async () => {
    const f = await fixture();
    try {
        const task = await f.api.tasks.create(taskFields);
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(1);
        await f.client`UPDATE mira_events SET created_at=now()-interval '2 days' WHERE kind='task_changed' AND task_id=${task.id}`;
        expect(await claimMiraRun(f.client, crypto.randomUUID(), "general")).toBeNull();
        const history = await f.api.runs.list({ search: "", archived: false });
        expect(history.rows[0]?.state).toBe("interrupted");
    } finally {
        await f.close();
    }
});

test("task-change discovery and latest-edit validation use selective paths through audit history", async () => {
    const f = await fixture();
    try {
        const task = await f.api.tasks.create(taskFields);
        await f.client`INSERT INTO mira_audit(id,owner,actor,action,target,created_at)
            SELECT gen_random_uuid(),'operator',CASE WHEN n%2=0 THEN 'human:operator' ELSE 'mira:worker' END,
                CASE WHEN n%2=0 THEN 'task.updated' ELSE 'report.created' END,${task.id},now()-interval '30 days'
            FROM generate_series(1,20000) n`;
        await f.client`ANALYZE mira_audit`;
        const plans: string[] = [];
        const query = ((strings: TemplateStringsArray, ...parameters: unknown[]) => {
            const statement = strings
                .map((part, index) => (index ? `$${index}${part}` : part))
                .join("");
            return f.client
                .unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`, parameters)
                .then((rows) => {
                    plans.push(JSON.stringify(rows));
                    return [];
                });
        }) as unknown as MiraQuery;
        await pendingTaskChanges(query, afterQuiet());
        expect(plans[0]).toContain("mira_audit_task_changes_recent");
        expect(await scheduleMiraRuns(f.client, afterQuiet())).toBe(1);
        const [event] = await f.client<
            { id: string }[]
        >`SELECT id FROM mira_events WHERE task_id=${task.id} AND kind='task_changed'`;
        if (!event) throw new Error("Expected assessment event.");
        await currentTaskChange(query, "operator", task.id, event.id);
        expect(plans[1]).toContain("mira_audit_task_changes_");
    } finally {
        await f.close();
    }
});
