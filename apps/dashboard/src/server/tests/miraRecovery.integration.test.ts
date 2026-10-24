import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    utimes,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { capabilities } from "@homelab/contracts/operations";
import {
    installMiraPresets,
    deleteMiraAutomation,
} from "@homelab/mira/data/automationActions";
import { miraQueueAvailable } from "@homelab/mira/data/capacity";
import { cleanupMiraFiles, readMiraFile, saveMiraFile } from "@homelab/mira/data/files";
import { miraObservationFingerprint } from "@homelab/mira/data/notifications";
import { claimMiraRun, finishMiraRun } from "@homelab/mira/data/queue";
import * as v from "valibot";

import {
    cleanupMiraConversations,
    cleanupMiraResources,
} from "../../../../mira/src/server/executor/cleanup";
import { readMiraTurnInput } from "../../../../mira/src/server/executor/context";
import {
    runMiraExecutor,
    type MiraHealth,
} from "../../../../mira/src/server/executor/runtime";
import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import { executeMiraTurn } from "../../../../mira/src/server/executor/turn";
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
        await fixture.client`UPDATE mira_conversations SET provider_thread='already-resumed',provider_context_ready=true WHERE id=${chat.id}`;
        const resumed = await readMiraTurnInput(fixture.client, retry);
        expect(resumed.content).toBe("Try again");
    } finally {
        await fixture.close();
    }
});

test("maximum run time cancels a stalled runtime setup before the inference timeout starts", async () => {
    const fixture = await operationFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-deadline-"));
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const command = path.join(directory, "synthetic-codex");
        const marker = path.join(directory, "started");
        const home = path.join(directory, "home"),
            workspace = path.join(directory, "workspace");
        await mkdir(home);
        await mkdir(workspace);
        await writeFile(
            command,
            `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(marker)},'started');\nsetInterval(()=>{},1000);\n`
        );
        await chmod(command, 0o700);
        const chat = await api.conversations.create({ title: "Deadline qualification" });
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Synthetic",
        });
        const claimed = await claimMiraRun(
            fixture.client,
            crypto.randomUUID(),
            "foreground"
        );
        if (!claimed) throw new Error("Expected run");
        const started = Date.now();
        await executeMiraTurn(
            fixture.client,
            { command, codexHome: home, workspace },
            { ...claimed, deadlineAt: started + 300 },
            new AbortController().signal
        );
        expect(Date.now() - started).toBeLessThan(2000);
        expect(await readFile(marker, "utf8")).toBe("started");
        const runs = await api.runs.list({ search: "", archived: false });
        expect(runs.rows[0]?.state).toBe("needs_attention");
        expect(runs.rows[0]?.message).toContain("Maximum run time");
    } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("failed terminal tool receipts roll back product mutations and fence fresh-call retries", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const taskInput = {
            title: "Synthetic",
            description: "Data",
            status: "todo" as const,
            assignee: "mira" as const,
            priority: "normal" as const,
            labels: [],
            dueAt: null,
            completionCriteria: "Review",
            conversationId: null,
        };
        const task = await api.tasks.create(taskInput);
        await fixture.client`CREATE FUNCTION fail_tool_receipt() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.state='succeeded' THEN RAISE EXCEPTION 'Synthetic receipt failure'; END IF; RETURN NEW; END$$`;
        await fixture.client`CREATE TRIGGER fail_tool_receipt BEFORE UPDATE ON mira_tool_receipts FOR EACH ROW EXECUTE FUNCTION fail_tool_receipt()`;
        const counts = async () =>
            fixture.client<
                { tasks: number; progress: number; reports: number; memory: number }[]
            >`SELECT (SELECT count(*)::int FROM mira_tasks) AS tasks,(SELECT count(*)::int FROM mira_progress) AS progress,(SELECT count(*)::int FROM mira_reports) AS reports,(SELECT count(*)::int FROM mira_memory) AS memory`;
        for (const [name, input] of [
            ["mira_task_create", taskInput],
            ["mira_task_progress", { taskId: task.id, text: "Synthetic progress" }],
            [
                "mira_report_create",
                { title: "Synthetic report", kind: "other", markdown: "Data" },
            ],
            ["mira_memory_create", { title: "Synthetic memory", content: "Data" }],
        ] as const) {
            const chat = await api.conversations.create({ title: "Atomic receipt" });
            await api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Synthetic product mutation",
            });
            const run = await claimMiraRun(
                fixture.client,
                crypto.randomUUID(),
                "foreground"
            );
            if (!run) throw new Error("Expected run");
            const tool = createMiraTools(fixture.client, run).find(
                (tool) => tool.name === name
            )!;
            const before = await counts();
            const result = await tool.execute(input, new AbortController().signal, {
                callId: "first",
                threadId: "synthetic",
                turnId: "turn",
            });
            expect(result).toContain("uncertain");
            expect(await counts()).toEqual(before);
            const retry = await tool.execute(input, new AbortController().signal, {
                callId: "fresh-retry",
                threadId: "synthetic",
                turnId: "turn",
            });
            expect(retry).toContain("Stop and review");
            expect(await counts()).toEqual(before);
            await finishMiraRun(fixture.client, run, {
                state: "completed",
                text: "Synthetic",
                message: null,
            });
            const [terminal] = await fixture.client<
                { state: string; pending: number }[]
            >`SELECT state,(SELECT count(*)::int FROM mira_tool_receipts WHERE run_id=${run.id} AND state='running') AS pending FROM mira_runs WHERE id=${run.id}`;
            expect(terminal).toEqual({ state: "needs_attention", pending: 0 });
        }
    } finally {
        await fixture.close();
    }
});

test("concurrent read-only tools do not reserve transactions while waiting for product reads", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const chat = await api.conversations.create({ title: "Parallel reads" });
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Read synthetic state",
        });
        const run = await claimMiraRun(fixture.client, crypto.randomUUID(), "foreground");
        if (!run) throw new Error("Expected run");
        const tool = createMiraTools(fixture.client, run).find(
            (tool) => tool.name === "mira_tasks_list"
        )!;
        const results = await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                tool.execute({ search: "" }, new AbortController().signal, {
                    callId: `read-${i}`,
                    threadId: "synthetic",
                    turnId: "turn",
                })
            )
        );
        expect(results.every((result) => result.includes('"ok":true'))).toBe(true);
        const [receipts] = await fixture.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_tool_receipts WHERE run_id=${run.id} AND state='succeeded'`;
        expect(receipts?.count).toBe(8);
    } finally {
        await fixture.close();
    }
});

test("an unavailable deployment default leaves explicit models selectable and executable", async () => {
    const fixture = await operationFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-default-model-"));
    const abort = new AbortController();
    let executor: Promise<void> | undefined;
    try {
        const command = path.join(directory, "synthetic-codex");
        const runtimeChild = fileURLToPath(
            new URL(
                "../../../../mira/src/server/testing/runtimeChild.ts",
                import.meta.url
            )
        );
        await writeFile(
            command,
            `#!/usr/bin/env bun\nprocess.argv=[process.argv[0],${JSON.stringify(runtimeChild)},'ok',${JSON.stringify(path.join(directory, "home"))}];\nawait import(${JSON.stringify(runtimeChild)});\n`
        );
        await chmod(command, 0o700);
        const home = path.join(directory, "home"),
            workspace = path.join(directory, "workspace");
        await mkdir(home);
        await mkdir(workspace);
        const health: MiraHealth = {
            ready: false,
            heartbeatAt: 0,
            draining: false,
            active: 0,
        };
        executor = runMiraExecutor({
            client: fixture.client,
            config: { command, codexHome: home, workspace, model: "removed-model" },
            version: "synthetic",
            health,
            signal: abort.signal,
        });
        const api = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "operator", capabilities },
        }).mira;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const catalog = await api.models();
            if (catalog.fresh) break;
            await delay(20);
        }
        expect(health.ready).toBe(true);
        const catalog = await api.models();
        expect(catalog.fresh).toBe(true);
        expect(catalog.defaultModel).toBe("removed-model");
        expect(catalog.models.map((model) => model.model)).toContain("synthetic");
        const chat = await api.conversations.create({
            title: "Explicit surviving model",
        });
        await api.conversations.settings({
            id: chat.id,
            version: 1,
            settings: { model: "synthetic", effort: null, serviceTier: null },
        });
        const run = await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Synthetic",
        });
        let state = "queued";
        while (Date.now() < deadline) {
            const [row] = await fixture.client<
                { state: string }[]
            >`SELECT state FROM mira_runs WHERE id=${run.id}`;
            state = row!.state;
            if (!["queued", "running"].includes(state)) break;
            await delay(20);
        }
        expect(state).toBe("completed");
    } finally {
        abort.abort();
        await executor;
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("preset restore preserves live edits and can reinstall an explicitly emptied collection", async () => {
    const fixture = await operationFixture();
    const context = {
        client: fixture.client,
        owner: "operator",
        actor: "human:operator",
    };
    try {
        expect(await installMiraPresets(context)).toEqual({ created: 4 });
        await fixture.client`UPDATE mira_automations SET title='Edited preset' WHERE owner='operator'`;
        expect(await installMiraPresets(context)).toEqual({ created: 0 });
        const rows = await fixture.client<
            { id: string; version: number }[]
        >`SELECT id,version FROM mira_automations WHERE owner='operator' AND deleted_at IS NULL`;
        for (const row of rows) await deleteMiraAutomation(context, row.id, row.version);
        const result = await Promise.all([
            installMiraPresets(context),
            installMiraPresets(context),
        ]);
        expect(result.map((value) => value.created).toSorted((a, b) => a - b)).toEqual([
            0, 4,
        ]);
        const [restored] = await fixture.client<
            { total: number; enabled: number }[]
        >`SELECT count(*)::int AS total, count(*) FILTER (WHERE c.enabled)::int AS enabled FROM mira_automations a JOIN mira_switches c ON c.owner=a.owner AND c.key='automation:'||a.id::text WHERE a.owner='operator' AND a.deleted_at IS NULL`;
        expect(restored).toEqual({ total: 4, enabled: 0 });
    } finally {
        await fixture.close();
    }
});

test("automatic tools read an exact old task without paging and reject foreign or deleted tasks", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const old = Bun.randomUUIDv7(),
            foreign = Bun.randomUUIDv7(),
            deleted = Bun.randomUUIDv7();
        await fixture.client`INSERT INTO mira_tasks (id,owner,title,description,completion_criteria,status,assignee,priority) VALUES (${old},'operator','Old due task','Original requirements','Specific evidence','todo','mira','normal'),(${foreign},'other','Private task','Private','Private','todo','mira','normal')`;
        await fixture.client`INSERT INTO mira_tasks (id,owner,title,deleted_at,status,assignee,priority,description,completion_criteria) VALUES (${deleted},'operator','Deleted task',now(),'todo','mira','normal','','')`;
        const newer = Array.from({ length: 1000 }, () => ({
            id: Bun.randomUUIDv7(),
            owner: "operator",
            title: "Newer task",
            description: "",
            completion_criteria: "",
            status: "todo",
            assignee: "mira",
            priority: "normal",
        }));
        await fixture.client`INSERT INTO mira_tasks ${fixture.client(newer)}`;
        const chat = await api.conversations.create({ title: "Due task lookup" });
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: old,
        });
        const run = await claimMiraRun(fixture.client, crypto.randomUUID(), "foreground");
        if (!run) throw new Error("Expected run");
        const tool = createMiraTools(fixture.client, {
            ...run,
            automationId: crypto.randomUUID(),
        }).find((item) => item.name === "mira_task_read")!;
        for (const id of [old, foreign, deleted]) {
            const result = v.parse(
                v.object({
                    ok: v.boolean(),
                    result: v.optional(v.unknown()),
                    message: v.optional(v.string()),
                }),
                JSON.parse(
                    await tool.execute({ id }, new AbortController().signal, {
                        callId: id,
                        threadId: "synthetic",
                        turnId: "turn",
                    })
                )
            );
            expect(result.ok).toBe(id === old);
            if (id === old)
                expect(result.result).toMatchObject({
                    id: old,
                    description: "Original requirements",
                    completionCriteria: "Specific evidence",
                });
            else expect(result.message).toBe("Task not found.");
        }
    } finally {
        await fixture.close();
    }
});

test("cancellation after creating a provider thread preserves historical context until its first acknowledged turn", async () => {
    const fixture = await operationFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-context-ack-"));
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const command = path.join(directory, "synthetic-codex");
        const home = path.join(directory, "home"),
            workspace = path.join(directory, "workspace");
        await mkdir(home);
        await mkdir(workspace);
        const runtimeChild = fileURLToPath(
            new URL(
                "../../../../mira/src/server/testing/runtimeChild.ts",
                import.meta.url
            )
        );
        await writeFile(
            command,
            `#!/usr/bin/env bun\nprocess.argv=[process.argv[0],${JSON.stringify(runtimeChild)},'ok',${JSON.stringify(home)}];\nawait import(${JSON.stringify(runtimeChild)});\n`
        );
        await chmod(command, 0o700);
        const config = { command, codexHome: home, workspace, model: "synthetic" };
        const chat = await api.conversations.create({
            title: "Interrupted context setup",
        });
        const next = async (text: string) => {
            await api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text,
            });
            const run = await claimMiraRun(
                fixture.client,
                crypto.randomUUID(),
                "foreground"
            );
            if (!run) throw new Error("Expected run");
            return run;
        };
        const first = await next("Remember this original task context");
        await finishMiraRun(fixture.client, first, {
            state: "needs_attention",
            text: "",
            message: "Synthetic setup failure",
        });
        await fixture.client`CREATE FUNCTION cancel_created_thread() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.provider_thread IS NOT NULL AND OLD.provider_thread IS NULL THEN UPDATE mira_runs SET cancel_requested=true WHERE conversation_id=NEW.id AND state='running'; END IF; RETURN NEW; END$$`;
        await fixture.client`CREATE TRIGGER cancel_created_thread AFTER UPDATE ON mira_conversations FOR EACH ROW EXECUTE FUNCTION cancel_created_thread()`;
        const cancelled = await next("Continue the task");
        await executeMiraTurn(
            fixture.client,
            config,
            cancelled,
            new AbortController().signal
        );
        const [before] = await fixture.client<
            { thread: string; ready: boolean }[]
        >`SELECT provider_thread AS thread,provider_context_ready AS ready FROM mira_conversations WHERE id=${chat.id}`;
        expect(before).toEqual({ thread: "thread-test", ready: false });
        const retry = await next("Retry after setup cancellation");
        const recovered = await readMiraTurnInput(fixture.client, retry);
        expect(recovered.content).toContain("Remember this original task context");
        await executeMiraTurn(
            fixture.client,
            config,
            retry,
            new AbortController().signal
        );
        const [after] = await fixture.client<
            { ready: boolean; turn: string }[]
        >`SELECT c.provider_context_ready AS ready,r.provider_turn AS turn FROM mira_conversations c JOIN mira_runs r ON r.conversation_id=c.id WHERE r.id=${retry.id}`;
        expect(after).toEqual({ ready: true, turn: "turn-1" });
        const final = await next("Continue without duplicated context");
        const resumed = await readMiraTurnInput(fixture.client, final);
        expect(resumed.content).toBe("Continue without duplicated context");
    } finally {
        await fixture.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("heartbeat run history exposes owned failures without reports or paging through successful work", async () => {
    const fixture = await operationFixture();
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const chat = await api.conversations.create({
            title: "Heartbeat failure history",
        });
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Review failures",
        });
        const run = await claimMiraRun(fixture.client, crypto.randomUUID(), "foreground");
        if (!run) throw new Error("Expected run");
        const fingerprint = () =>
            fixture.client.begin((query) =>
                miraObservationFingerprint(query, "operator")
            );
        const before = await fingerprint();
        const failure = Bun.randomUUIDv7();
        const row = (id: string, owner: string, state: string) => ({
            id,
            owner,
            state,
            request_key: `synthetic:${id}`,
            request_hash: "synthetic",
            conversation_id: chat.id,
            user_message_id: run.userMessageId,
            assistant_message_id: run.assistantMessageId,
            priority: 1,
            budget_seconds: 60,
            message: "Synthetic failure without a report",
        });
        await fixture.client`INSERT INTO mira_runs ${fixture.client(row(failure, "operator", "failed"))}`;
        const changed = await fingerprint();
        expect(changed).not.toBe(before);
        await fixture.client`INSERT INTO mira_runs ${fixture.client(row(Bun.randomUUIDv7(), "other", "failed"))}`;
        await fixture.client`INSERT INTO mira_runs ${fixture.client(Array.from({ length: 40 }, () => row(Bun.randomUUIDv7(), "operator", "completed")))}`;
        expect(await fingerprint()).toBe(changed);
        const tool = createMiraTools(fixture.client, {
            ...run,
            automationId: crypto.randomUUID(),
        }).find((item) => item.name === "mira_runs_list")!;
        const output: unknown = JSON.parse(
            await tool.execute({}, new AbortController().signal, {
                callId: "failures",
                threadId: "synthetic",
                turnId: "turn",
            })
        );
        const parsed = v.parse(
            v.object({
                ok: v.literal(true),
                result: v.object({
                    rows: v.array(v.object({ id: v.string(), state: v.string() })),
                }),
            }),
            output
        );
        expect(parsed.result.rows).toEqual([{ id: failure, state: "failed" }]);
    } finally {
        await fixture.close();
    }
});
