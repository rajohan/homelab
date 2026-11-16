import { expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { MiraAttachment } from "@homelab/contracts/mira";
import { capabilities } from "@homelab/contracts/operations";
import { deleteMiraFile, readMiraFile } from "@homelab/mira/data/files";
import { publishHereNowBinding } from "@homelab/mira/data/herenow";
import { claimMiraRun, finishMiraRun } from "@homelab/mira/data/queue";
import { hereNowBindingHash } from "@homelab/mira/integrations/herenow/configuration";

import * as generated from "../../../../mira/src/server/executor/generatedFiles";
import { appRouter } from "../api/router";
import { createMiraTextTestTools as createMiraTools } from "../testing/miraTools";
import { operationFixture } from "../testing/operations";

const hereNow = {
    owner: "operator",
    accountId: "11111111-1111-4111-8111-111111111111",
    apiKey: "synthetic-read-credential",
};
const content = "# Generated report\n\nNorwegian: øæå.\n";
interface Outcome {
    ok: boolean;
    retryable?: boolean;
    result?: { file: MiraAttachment };
    message?: string;
}
async function fixture() {
    const f = await operationFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-generated-"));
    const context = { client: f.client, owner: "operator", actor: "human:operator" };
    const api = appRouter.createCaller({
        operations: { ...f, miraFilesDirectory: directory, hereNowBinding: hereNow },
        principal: { kind: "human", id: context.owner, capabilities },
    }).mira;
    const chat = await api.conversations.create({ title: "Generate files" });
    await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Create the requested report as a file.",
    });
    const claimed = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
    expect(claimed).not.toBeNull();
    const run = claimed!;
    const controller = new AbortController();
    const tools = createMiraTools(
        f.client,
        run,
        directory,
        undefined,
        undefined,
        hereNow
    );
    const invoke = async (input: unknown, callId = crypto.randomUUID()) =>
        JSON.parse(
            await tools
                .find((tool) => tool.name === "mira_file_create")!
                .execute(input, controller.signal, {
                    callId,
                    threadId: "synthetic",
                    turnId: "synthetic",
                })
        ) as Outcome;
    const create = (name = "report.md", text = content) =>
        invoke({ name, content: text });
    const files = async () =>
        f.client<
            { id: string; readyAt: Date | null }[]
        >`SELECT id,ready_at AS "readyAt" FROM mira_attachments`;
    const attached = async () => {
        const [message] = await f.client<
            { ids: string }[]
        >`SELECT attachment_ids::text AS ids FROM mira_messages WHERE id=${run.assistantMessageId}`;
        return JSON.parse(message!.ids) as string[];
    };
    return {
        ...f,
        directory,
        context,
        api,
        chat,
        run,
        controller,
        tools,
        invoke,
        create,
        files,
        attached,
        close: async () => {
            try {
                await f.close();
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        },
    };
}

test("generated files are readable owned attachments, survive completion and deduplicate identical tool retries", async () => {
    const f = await fixture();
    try {
        const first = await f.create();
        expect(first.ok).toBe(true);
        const file = first.result!.file;
        expect(file).toMatchObject({
            name: "report.md",
            mediaType: "text/plain; charset=utf-8",
        });
        const second = await f.create();
        expect(second.result!.file.id).toBe(file.id);
        expect(await f.files()).toHaveLength(1);
        expect(await f.attached()).toEqual([file.id]);
        const read = await readMiraFile(f.context, f.directory, file.id);
        expect(new TextDecoder().decode(read.bytes)).toBe(content);
        const text = JSON.parse(
            await f.tools
                .find((tool) => tool.name === "mira_attachment_read")!
                .execute({ id: file.id }, f.controller.signal, {
                    callId: "read-created",
                    threadId: "synthetic",
                    turnId: "synthetic",
                })
        ) as { ok: boolean; result: { text: string } };
        expect(text).toMatchObject({ ok: true, result: { text: content } });
        await rejects(
            readMiraFile({ ...f.context, owner: "other" }, f.directory, file.id),
            /not found/
        );
        await rejects(deleteMiraFile(f.context, f.directory, file.id), /Stop or finish/);
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            message: null,
            text: "Your file is ready.",
        });
        expect(await f.attached()).toEqual([file.id]);
        await deleteMiraFile(f.context, f.directory, file.id);
        await rejects(readMiraFile(f.context, f.directory, file.id), /not found/);
    } finally {
        await f.close();
    }
});

test("changed content creates an immutable new artifact and another run cannot adopt the old identity", async () => {
    const f = await fixture();
    try {
        const firstResult = await f.create();
        const first = firstResult.result!.file;
        const changedResult = await f.create("report.md", "Changed report");
        const changed = changedResult.result!.file;
        expect(changed.id).not.toBe(first.id);
        const originalBytes = await readMiraFile(f.context, f.directory, first.id);
        const changedBytes = await readMiraFile(f.context, f.directory, changed.id);
        expect(new TextDecoder().decode(originalBytes.bytes)).toBe(content);
        expect(new TextDecoder().decode(changedBytes.bytes)).toBe("Changed report");
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            message: null,
            text: "Two versions.",
        });
        await f.api.conversations.send({
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Create another copy.",
        });
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        const next = await generated.saveGeneratedMiraFile(
            f.client,
            run!,
            f.directory,
            { name: "report.md", content },
            new AbortController().signal
        );
        expect(next.file.id).not.toBe(first.id);
        expect(await f.files()).toHaveLength(3);
    } finally {
        await f.close();
    }
});

test("invalid names, unscoped arguments, binary content and byte overflow leave no file reservation", async () => {
    const f = await fixture();
    try {
        for (const input of [
            { name: "../escape.html", content },
            { name: "empty.txt", content: "" },
            { name: "owned.txt", content, owner: "other" },
            { name: "high.txt", content: "\uD800" },
            { name: "low.txt", content: "\uDC00" },
            { name: "mixed.txt", content: "before\uD800after" },
            { name: "invalid\uD800.txt", content },
            { name: "large.txt", content: "x".repeat(1_048_577) },
            { name: "unicode.txt", content: "😀".repeat(262_145) },
            { name: "binary.txt", content: "bad\u0000text" },
            { name: "fake.pdf", content: "%PDF-1.0\nNot a generated text artifact" },
        ])
            expect(await f.invoke(input)).toMatchObject({ ok: false, retryable: true });
        expect(await f.files()).toHaveLength(0);
        expect(await f.attached()).toEqual([]);
        expect(await f.create()).toMatchObject({ ok: true });
    } finally {
        await f.close();
    }
});

test("100 response files include the final concurrent slot without orphaned reservations", async () => {
    const f = await fixture();
    try {
        for (let index = 0; index < 99; index++) {
            expect(await f.create(`part-${index}.txt`)).toMatchObject({ ok: true });
            // Exercise per-run capacity independently of the unchanged per-minute upload limit.
            await f.client`UPDATE mira_attachments SET created_at=now()-interval '2 minutes'`;
        }
        const outcomes = await Promise.all([
            f.create("part-a.txt"),
            f.create("part-b.txt"),
        ]);
        expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
        expect(await f.files()).toHaveLength(100);
        const files = await f.files();
        expect(files.every((file) => file.readyAt !== null)).toBe(true);
        expect(await f.attached()).toHaveLength(100);
        expect(await f.create("overflow.txt")).toMatchObject({ ok: false });
        expect(await f.create("part-0.txt")).toMatchObject({ ok: true });
        expect(await f.files()).toHaveLength(100);
    } finally {
        await f.close();
    }
});

for (const change of ["lease", "cancel", "signal"] as const)
    test(`generated file admission rolls back after ${change} while waiting for storage`, async () => {
        const f = await fixture();
        let pending: Promise<Outcome> | undefined;
        try {
            await f.client.begin(async (query) => {
                await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:controls:operator',0))`;
                pending = f.create();
                let waiting = false;
                for (let index = 0; index < 100; index++) {
                    const [locks] = await f.client<
                        { count: number }[]
                    >`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`;
                    if (locks!.count > 0) {
                        waiting = true;
                        break;
                    }
                    await Bun.sleep(10);
                }
                expect(waiting).toBe(true);
                if (change === "lease")
                    await query`UPDATE mira_runs SET lease_expires_at=now()-interval '1 second' WHERE id=${f.run.id}`;
                else if (change === "cancel")
                    await query`UPDATE mira_runs SET cancel_requested=true WHERE id=${f.run.id}`;
                else f.controller.abort();
            });
            expect(await pending).toMatchObject({ ok: false, retryable: true });
            expect(await f.files()).toHaveLength(0);
            expect(await f.attached()).toEqual([]);
        } finally {
            await pending;
            await f.close();
        }
    });

test("automatic runs and missing file storage cannot create artifacts", async () => {
    const f = await fixture();
    try {
        await rejects(
            generated.saveGeneratedMiraFile(
                f.client,
                { ...f.run, automationId: crypto.randomUUID() },
                f.directory,
                { name: "report.md", content },
                f.controller.signal
            ),
            /manual/
        );
        await rejects(
            generated.saveGeneratedMiraFile(
                f.client,
                f.run,
                undefined,
                { name: "report.md", content },
                f.controller.signal
            ),
            /configured/
        );
        expect(await f.files()).toHaveLength(0);
    } finally {
        await f.close();
    }
});

test("a generated file remains visible after lost tool acknowledgement and fences subsequent actions", async () => {
    const f = await fixture();
    const original = generated.saveGeneratedMiraFile;
    const save = spyOn(generated, "saveGeneratedMiraFile").mockImplementation(
        async (...args) => {
            const result = await original(...args);
            f.controller.abort();
            return result;
        }
    );
    try {
        expect(await f.create()).toMatchObject({ ok: false, retryable: false });
        expect(await f.files()).toHaveLength(1);
        expect(await f.attached()).toHaveLength(1);
        const later = JSON.parse(
            await f.tools
                .find((tool) => tool.name === "mira_controls_list")!
                .execute({}, new AbortController().signal, {
                    callId: "later",
                    threadId: "synthetic",
                    turnId: "synthetic",
                })
        ) as Outcome;
        expect(later).toMatchObject({ ok: false, retryable: false });
        const [receipt] = await f.client<
            { state: string }[]
        >`SELECT state FROM mira_tool_receipts WHERE run_id=${f.run.id} AND tool='mira_file_create'`;
        expect(receipt!.state).toBe("unknown");
    } finally {
        save.mockRestore();
        await f.close();
    }
});

test("Mira can propose its generated site through the existing reviewed publication flow", async () => {
    const f = await fixture();
    try {
        await f.client`INSERT INTO mira_runtime_status(id,worker_id,version,ready,heartbeat_at,integrations) VALUES (1,${crypto.randomUUID()},'synthetic',true,now(),${JSON.stringify([{ owner: hereNow.owner, key: "here-now", bindingHash: hereNowBindingHash(hereNow) }])}::text::jsonb)`;
        await publishHereNowBinding(f.client, hereNow);
        await f.api.controls.setEnabled({
            key: "integration:here-now",
            enabled: true,
            version: 1,
            reason: null,
            until: null,
        });
        const resultFile = await f.create("index.html", "<h1>Generated page</h1>");
        const file = resultFile.result!.file;
        const result = JSON.parse(
            await f.tools
                .find((tool) => tool.name === "mira_herenow_publication_draft")!
                .execute(
                    {
                        id: crypto.randomUUID(),
                        version: 0,
                        content: {
                            title: "Generated site",
                            target: null,
                            visibility: "anyone_with_link",
                            files: [{ id: file.id, path: "index.html" }],
                        },
                    },
                    f.controller.signal,
                    { callId: "draft", threadId: "synthetic", turnId: "synthetic" }
                )
        ) as Outcome;
        expect(result.ok).toBe(true);
        const publications = await f.api.publications.list({ conversationId: f.chat.id });
        expect(publications.rows).toHaveLength(1);
        expect(publications.rows[0]).toMatchObject({
            state: "draft",
            content: {
                files: [
                    {
                        id: file.id,
                        path: "index.html",
                        mediaType: "text/html; charset=utf-8",
                    },
                ],
            },
        });
    } finally {
        await f.close();
    }
});

test("valid Unicode and an actual replacement character retain their exact UTF-8 bytes", async () => {
    const f = await fixture();
    try {
        for (const text of ["\uFFFD", "\uFEFFNorsk øæå, emoji 😀, replacement �"]) {
            const result = await f.create("unicode.txt", text);
            expect(result.ok).toBe(true);
            const file = await readMiraFile(
                f.context,
                f.directory,
                result.result!.file.id
            );
            expect(file.bytes).toEqual(Buffer.from(new TextEncoder().encode(text)));
        }
        expect(await f.files()).toHaveLength(2);
    } finally {
        await f.close();
    }
});

test("generated attachments remain on their original reply after later commentary", async () => {
    const f = await fixture();
    try {
        const initial = {
            id: Bun.randomUUIDv7(),
            offset: 0,
            createdAt: new Date().toISOString(),
        };
        const early = await f.create("early.txt");
        await f.client`UPDATE mira_messages SET content='First',parts=${JSON.stringify([initial])}::text::jsonb WHERE id=${f.run.assistantMessageId}`;
        const first = await f.create("first.txt");
        const secondPart = {
            id: Bun.randomUUIDv7(),
            offset: 5,
            createdAt: new Date().toISOString(),
        };
        await f.client`UPDATE mira_messages SET content='FirstSecond',parts=${JSON.stringify([initial, secondPart])}::text::jsonb WHERE id=${f.run.assistantMessageId}`;
        const second = await f.create("second.txt");
        const lastPart = {
            id: Bun.randomUUIDv7(),
            offset: 11,
            createdAt: new Date().toISOString(),
        };
        await f.client`UPDATE mira_messages SET content='FirstSecondLast',parts=${JSON.stringify([initial, secondPart, lastPart])}::text::jsonb WHERE id=${f.run.assistantMessageId}`;
        const chat = await f.api.conversations.read({ id: f.chat.id });
        expect(chat.messages.find((row) => row.id === initial.id)?.attachmentIds).toEqual(
            [early.result!.file.id, first.result!.file.id]
        );
        expect(
            chat.messages.find((row) => row.id === secondPart.id)?.attachmentIds
        ).toEqual([second.result!.file.id]);
        expect(
            chat.messages.find((row) => row.id === lastPart.id)?.attachmentIds
        ).toEqual([]);
    } finally {
        await f.close();
    }
});

test("activity pages include recent tools beyond 32 and preserve work notes across phases", async () => {
    const f = await fixture();
    try {
        for (let index = 0; index < 65; index++) {
            await f.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${Bun.randomUUIDv7()},${f.run.id},${`page-${index}`},${`tool_${index}`},'test','succeeded')`;
        }
        const latest = await f.api.activity({ id: f.run.id, kind: "tools" });
        expect(latest.total).toBe(65);
        expect(latest.rows.at(-1)?.tool).toBe("tool_64");
        const older = await f.api.activity({
            id: f.run.id,
            kind: "tools",
            before: latest.nextCursor!,
        });
        expect(older.rows.at(-1)?.tool).toBe("tool_34");
        expect(new Set([...older.rows, ...latest.rows].map((row) => row.id)).size).toBe(
            60
        );
        const read = await f.api.conversations.read({ id: f.chat.id });
        expect(read.tools.at(-1)?.tool).toBe("tool_64");
        for (const thinking of ["First", "First note", "Second note"]) {
            await f.client`UPDATE mira_runs SET activity=${JSON.stringify({ phase: "thinking", tool: null, thinking })}::text::jsonb WHERE id=${f.run.id}`;
        }
        const notes = await f.api.activity({ id: f.run.id, kind: "notes" });
        expect(notes.rows.map((row) => row.message)).toEqual([
            "First note",
            "Second note",
        ]);
        await expect(
            f.api.activity({ id: crypto.randomUUID(), kind: "tools" })
        ).rejects.toThrow("Run not found");
    } finally {
        await f.close();
    }
});

test("long work notes retain bounded nonoverlapping pages after the provider tail rolls", async () => {
    const f = await fixture();
    try {
        const content = "ø".repeat(32_000);
        const activity = (thinking: string, thinkingOffset: number) =>
            JSON.stringify({
                phase: "thinking",
                tool: null,
                thinking,
                thinkingId: f.run.id,
                thinkingOffset,
            });
        await f.client`UPDATE mira_runs SET activity=${activity(content, 0)}::text::jsonb WHERE id=${f.run.id}`;
        await f.client`UPDATE mira_runs SET activity=${activity(content.slice(3) + "end", 3)}::text::jsonb WHERE id=${f.run.id}`;
        const notes = await f.api.activity({ id: f.run.id, kind: "notes" });
        expect(notes.rows.map((row) => row.message).join("")).toBe(content + "end");
        expect(notes.rows.every((row) => (row.message?.length ?? 0) <= 8000)).toBe(true);
        expect(notes.total).toBe(5);
    } finally {
        await f.close();
    }
});
