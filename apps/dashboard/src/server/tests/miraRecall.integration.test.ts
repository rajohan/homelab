import { expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { miraDefaultChatSettings } from "@homelab/contracts/mira";
import { capabilities } from "@homelab/contracts/operations";
import { claimMiraRun } from "@homelab/mira/data/queue";
import {
    readMiraHistory,
    readMiraRecallContext,
    readMiraRecallPolicy,
    searchMiraHistory,
} from "@homelab/mira/data/recall";

import {
    executeMiraTurn,
    miraInstructionsHash,
} from "../../../../mira/src/server/executor/turn";
import { CodexRuntime } from "../../../../mira/src/server/runtime/codexRuntime";
import { appRouter } from "../api/router";
import { createMiraTextTestTools } from "../testing/miraTools";
import { operationFixture } from "../testing/operations";

async function fixture() {
    const f = await operationFixture();
    const api = appRouter.createCaller({
        operations: f,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    await f.client`INSERT INTO mira_runtime_status(id,worker_id,version,ready,heartbeat_at) VALUES(1,${crypto.randomUUID()},'fixture',true,now())`;
    const chat = await api.conversations.create({ title: "Current chat" });
    const start = async () => {
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Find the earlier fjordplan decision.",
        });
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        if (!run) throw new Error("Expected fixture run.");
        return run;
    };
    const source = async (
        owner = "operator",
        content = "Fjordplan uses blåbær for the Norwegian fixture."
    ) => {
        const conversationId = Bun.randomUUIDv7(),
            messageId = Bun.randomUUIDv7();
        await f.client`INSERT INTO mira_conversations(id,owner,title) VALUES(${conversationId},${owner},'Earlier decision')`;
        await f.client`INSERT INTO mira_messages(id,conversation_id,role,content,state) VALUES(${messageId},${conversationId},'assistant',${content},'completed')`;
        return { conversationId, messageId };
    };
    return { ...f, api, chat, start, source };
}

test("history recall isolates owners and excludes current, archived, deleted, opted-out and incomplete messages", async () => {
    const f = await fixture();
    try {
        const visible = await f.source();
        const foreign = await f.source("other");
        const archived = await f.source();
        const deleted = await f.source();
        const excluded = await f.source();
        const failed = await f.source();
        await f.client`UPDATE mira_conversations SET archived_at=now() WHERE id=${archived.conversationId}`;
        await f.client`UPDATE mira_conversations SET deleted_at=now() WHERE id=${deleted.conversationId}`;
        await f.client`UPDATE mira_conversations SET settings=settings || '{"useHistory":false}'::jsonb WHERE id=${excluded.conversationId}`;
        await f.client`UPDATE mira_messages SET state='failed' WHERE id=${failed.messageId}`;
        const run = await f.start();
        const result = await searchMiraHistory(f.client, run, {
            query: "fjordplan blåbær",
        });
        expect(result.moreAvailable).toBe(false);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
            ...visible,
            source: `/mira/${visible.conversationId}`,
        });
        for (const messageId of [
            foreign.messageId,
            archived.messageId,
            deleted.messageId,
            excluded.messageId,
            failed.messageId,
            run.userMessageId,
        ])
            await rejects(
                readMiraHistory(f.client, run, { messageId, offset: 0 }),
                /Historical message not found/
            );
        await f.client`UPDATE mira_conversations SET settings=settings || '{"useHistory":false}'::jsonb WHERE id=${visible.conversationId}`;
        const excludedResult = await searchMiraHistory(f.client, run, {
            query: "fjordplan",
        });
        expect(excludedResult.rows).toEqual([]);
        await rejects(
            readMiraHistory(f.client, run, { messageId: visible.messageId, offset: 0 }),
            /not found/
        );
    } finally {
        await f.close();
    }
});

test("recall bounds search, Unicode message chunks and memory snapshots without mixing accounts", async () => {
    const f = await fixture();
    try {
        const content = "🦊".repeat(6000) + "fjordplan continued";
        const long = await f.source("operator", content);
        for (let i = 0; i < 9; i++) await f.source();
        for (let i = 0; i < 13; i++)
            await f.client`INSERT INTO mira_memory(id,owner,title,content) VALUES(${Bun.randomUUIDv7()},'operator',${`Memory ${i}`},${"x".repeat(1001)})`;
        await f.client`INSERT INTO mira_memory(id,owner,title,content) VALUES(${Bun.randomUUIDv7()},'other','Other account','PRIVATE FOREIGN MEMORY')`;
        const run = await f.start();
        const result = await searchMiraHistory(f.client, run, { query: "fjordplan" });
        expect(result.rows).toHaveLength(8);
        expect(result.moreAvailable).toBe(true);
        // PostgreSQL counts code points; JavaScript can use two UTF-16 units per point.
        expect(result.rows.every((row) => row.excerpt.length <= 4800)).toBe(true);
        const first = await readMiraHistory(f.client, run, {
            messageId: long.messageId,
            offset: 0,
        });
        expect(first.content).toBe("🦊".repeat(6000));
        expect(first.nextOffset).toBe(6000);
        const last = await readMiraHistory(f.client, run, {
            messageId: long.messageId,
            offset: first.nextOffset!,
        });
        expect(last.content).toBe("fjordplan continued");
        expect(last.nextOffset).toBeNull();
        const context = await readMiraRecallContext(f.client, run);
        expect(context).toContain("Additional records omitted");
        expect(context).not.toContain("PRIVATE FOREIGN MEMORY");
        expect(context).not.toContain("x".repeat(1001));
        expect(context.match(/"truncated":true/g)).toHaveLength(12);
    } finally {
        await f.close();
    }
});

test("context preferences stay editable offline, freeze per run and fence disabled tools and stale leases", async () => {
    const f = await fixture();
    try {
        const source = await f.source();
        await f.client`UPDATE mira_runtime_status SET ready=false WHERE id=1`;
        await f.api.conversations.settings({
            id: f.chat.id,
            version: 1,
            settings: { ...miraDefaultChatSettings, useMemory: false, useHistory: false },
        });
        await rejects(
            f.api.conversations.settings({
                id: f.chat.id,
                version: 2,
                settings: { ...miraDefaultChatSettings, model: "unavailable" },
            }),
            /Reconnect/
        );
        await f.client`UPDATE mira_runtime_status SET ready=true WHERE id=1`;
        const run = await f.start();
        expect(await readMiraRecallPolicy(f.client, run)).toEqual({
            memory: false,
            history: false,
        });
        await rejects(
            f.api.conversations.settings({
                id: f.chat.id,
                version: 2,
                settings: miraDefaultChatSettings,
            }),
            /changed|Wait/
        );
        // The queued snapshot, not a later preference edit, controls the running turn.
        await f.client`UPDATE mira_conversations SET settings=${JSON.stringify(miraDefaultChatSettings)}::text::jsonb WHERE id=${f.chat.id}`;
        expect(await readMiraRecallPolicy(f.client, run)).toEqual({
            memory: false,
            history: false,
        });
        await rejects(
            searchMiraHistory(f.client, run, { query: "fjordplan" }),
            /disabled/
        );
        await rejects(
            readMiraHistory(f.client, run, { messageId: source.messageId, offset: 0 }),
            /disabled/
        );
        const tools = createMiraTextTestTools(f.client, run);
        for (const [name, input] of [
            ["mira_memory_list", {}],
            ["mira_memory_create", { title: "Forbidden", content: "Do not save" }],
            [
                "mira_memory_update",
                {
                    id: crypto.randomUUID(),
                    version: 1,
                    title: "Forbidden",
                    content: "Do not save",
                },
            ],
            ["mira_memory_delete", { id: crypto.randomUUID(), version: 1 }],
        ] as const) {
            const output = await tools
                .find((tool) => tool.name === name)!
                .execute(input, new AbortController().signal, {
                    callId: crypto.randomUUID(),
                    threadId: "fixture",
                    turnId: "fixture",
                });
            expect(JSON.parse(output)).toMatchObject({ ok: false });
        }
        const [receipts] = await f.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_tool_receipts WHERE run_id=${run.id}`;
        expect(receipts?.count).toBe(0);
        await f.client`UPDATE mira_runs SET lease_expires_at=now()-interval '1 second' WHERE id=${run.id}`;
        await rejects(readMiraRecallContext(f.client, run), /no longer available/);
    } finally {
        await f.close();
    }
});

test("automatic memory maintenance creates, revises and removes owned notes without proposals or stale overwrites", async () => {
    const f = await fixture();
    try {
        const automation = await f.api.automations.create({
            title: "Memory upkeep",
            kind: "custom",
            prompt: "Review memory",
            schedule: { kind: "daily", time: "03:30" },
            budgetSeconds: 180,
        });
        const run = await f.start();
        await f.client`UPDATE mira_runs SET automation_id=${automation.id},automation_kind='custom' WHERE id=${run.id}`;
        const tools = createMiraTextTestTools(f.client, {
            ...run,
            automationId: automation.id,
        });
        const invoke = async (
            name: string,
            input: unknown,
            callId: string = crypto.randomUUID()
        ) =>
            JSON.parse(
                await tools
                    .find((tool) => tool.name === name)!
                    .execute(input, new AbortController().signal, {
                        callId,
                        threadId: "fixture",
                        turnId: "fixture",
                    })
            ) as { ok: boolean; result?: { id: string } };
        const created = await invoke(
            "mira_memory_create",
            { title: "Preferred format", content: "Use short Norwegian replies." },
            "save-once"
        );
        expect(created.ok).toBe(true);
        expect(
            await invoke(
                "mira_memory_create",
                { title: "Preferred format", content: "Duplicate replay" },
                "save-once"
            )
        ).toMatchObject({ ok: false });
        const id = created.result!.id;
        expect(await f.api.proposals.list({ id: f.chat.id })).toHaveLength(0);
        expect(
            await invoke("mira_memory_update", {
                id,
                version: 1,
                title: "Preferred format",
                content: "Use detailed Norwegian replies for technical work.",
            })
        ).toMatchObject({ ok: true });
        expect(await invoke("mira_memory_delete", { id, version: 1 })).toMatchObject({
            ok: false,
        });
        const memory = await f.api.memory.list({ search: "" });
        expect(memory.rows).toHaveLength(1);
        expect(memory.rows[0]).toMatchObject({
            version: 2,
            content: "Use detailed Norwegian replies for technical work.",
        });
        const foreign = Bun.randomUUIDv7();
        await f.client`INSERT INTO mira_memory(id,owner,title,content) VALUES(${foreign},'other','Private','Leave intact')`;
        expect(
            await invoke("mira_memory_delete", { id: foreign, version: 1 })
        ).toMatchObject({ ok: false });
        expect(
            await invoke("mira_memory_update", {
                id: foreign,
                version: 1,
                title: "Changed",
                content: "Wrong owner",
            })
        ).toMatchObject({ ok: false });
        expect(await invoke("mira_memory_delete", { id, version: 2 })).toMatchObject({
            ok: true,
        });
        const remaining = await f.api.memory.list({ search: "" });
        expect(remaining.rows).toHaveLength(0);
        const actions = await f.client<
            { action: string }[]
        >`SELECT action FROM mira_audit WHERE owner='operator' AND target=${id} ORDER BY created_at`;
        expect(actions.map((row) => row.action)).toEqual([
            "memory.created",
            "memory.updated",
            "memory.deleted",
        ]);
        await f.client`UPDATE mira_runs SET automation_kind='improvement' WHERE id=${run.id}`;
        expect(
            await invoke("mira_memory_create", {
                title: "Not allowed",
                content: "Private memory",
            })
        ).toMatchObject({ ok: false });
    } finally {
        await f.close();
    }
});

test("legacy defaults enable recall while task assessments and improvement work cannot retrieve private context", async () => {
    const f = await fixture();
    try {
        const run = await f.start();
        expect(await readMiraRecallPolicy(f.client, run)).toEqual({
            memory: true,
            history: true,
        });
        expect(
            await readMiraRecallPolicy(f.client, { ...run, taskAssessment: true })
        ).toEqual({ memory: false, history: false });
        for (const kind of ["custom", "improvement"] as const) {
            const automation = await f.api.automations.create({
                title: "Context fixture",
                kind,
                prompt: "Inspect context",
                schedule: { kind: "interval", intervalSeconds: 60 },
                budgetSeconds: 60,
                settings: {
                    ...miraDefaultChatSettings,
                    useMemory: true,
                    useHistory: true,
                },
            });
            await f.client`UPDATE mira_runs SET automation_id=${automation.id},automation_kind=${kind} WHERE id=${run.id}`;
            expect(await readMiraRecallPolicy(f.client, run)).toEqual({
                memory: kind === "custom",
                history: kind === "custom",
            });
        }
        const context = await readMiraRecallContext(f.client, run);
        expect(context).toContain("saved memory disabled");
        await rejects(
            searchMiraHistory(f.client, run, { query: "fjordplan" }),
            /disabled/
        );
        await f.client`UPDATE mira_runs SET automation_kind=NULL WHERE id=${run.id}`;
        expect(await readMiraRecallPolicy(f.client, run)).toEqual({
            memory: false,
            history: false,
        });
    } finally {
        await f.close();
    }
});

test.each([true, false])(
    "native execution refreshes memory and retires broader provider context when recall is %s",
    async (enabled) => {
        const f = await fixture();
        const directory = await mkdtemp(path.join(tmpdir(), "mira-recall-"));
        const start = spyOn(CodexRuntime.prototype, "startThread");
        try {
            const home = path.join(directory, "home"),
                workspace = path.join(directory, "workspace"),
                command = path.join(directory, "fixture-codex");
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
                `#!/usr/bin/env bun\nprocess.argv=[process.argv[0],${JSON.stringify(child)},"policy-rotation",${JSON.stringify(home)}];\nawait import(${JSON.stringify(child)});\n`
            );
            await chmod(command, 0o700);
            await f.client`INSERT INTO mira_memory(id,owner,title,content) VALUES(${Bun.randomUUIDv7()},'operator','Preference','CURRENT MEMORY ZK-981')`;
            await f.api.conversations.settings({
                id: f.chat.id,
                version: 1,
                settings: {
                    ...miraDefaultChatSettings,
                    useMemory: enabled,
                    useHistory: enabled,
                },
            });
            await f.client`UPDATE mira_conversations SET provider_thread='stored-thread',provider_policy_hash=${enabled ? "previous-instructions" : miraInstructionsHash},provider_context_ready=true WHERE id=${f.chat.id}`;
            const run = await f.start();
            await executeMiraTurn(
                f.client,
                { command, codexHome: home, workspace, model: "synthetic" },
                run,
                new AbortController().signal
            );
            const detail = await f.api.conversations.read({ id: f.chat.id });
            expect(detail.run?.state).toBe("completed");
            const response = detail.messages.at(-1)?.content ?? "";
            expect(response).toContain(
                `saved memory ${enabled ? "enabled" : "disabled"}`
            );
            expect(response.includes("CURRENT MEMORY ZK-981")).toBe(enabled);
            const registry = start.mock.calls[0]![2].find(
                (tool) => tool.name === "mira_tools_list"
            )!;
            const names = JSON.stringify(
                await registry.execute({}, new AbortController().signal, {
                    callId: "discovery",
                    threadId: "fixture",
                    turnId: "fixture",
                })
            );
            expect(names.includes("mira_memory_list")).toBe(enabled);
            expect(names.includes("mira_history_search")).toBe(enabled);
            const [stored] = await f.client<
                { hash: string }[]
            >`SELECT provider_policy_hash AS hash FROM mira_conversations WHERE id=${f.chat.id}`;
            expect(stored?.hash === miraInstructionsHash).toBe(enabled);
        } finally {
            start.mockRestore();
            await f.close();
            await rm(directory, { recursive: true, force: true });
        }
    }
);
