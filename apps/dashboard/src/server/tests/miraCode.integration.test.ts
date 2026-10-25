import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { MiraCodePublication } from "@homelab/contracts/miraCode";
import { capabilities } from "@homelab/contracts/operations";
import { approveMiraCode } from "@homelab/mira/data/code";
import { saveMiraFile, deleteMiraFile } from "@homelab/mira/data/files";
import { publishGitHubBinding } from "@homelab/mira/data/github";
import { claimMiraRun } from "@homelab/mira/data/queue";
import { githubBindingHash } from "@homelab/mira/integrations/github/configuration";
import {
    dispatchMiraCode,
    reconcileMiraCode,
    inspectMiraCodeAttempt,
} from "@homelab/mira/integrations/github/outbox";

import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import { daytonaEditContent } from "../../../../mira/src/server/sandbox/profile";
import {
    bytes,
    base,
    configuration,
    githubProvider,
} from "../../../../mira/src/server/testing/github";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

const binding = { owner: configuration.owner },
    signal = new AbortController().signal;
async function fixture() {
    const f = await operationFixture(),
        directory = await mkdtemp(path.join(tmpdir(), "mira-code-"));
    const context = {
        client: f.client,
        owner: binding.owner,
        actor: `human:${binding.owner}`,
    };
    const file = await saveMiraFile(context, directory, {
        id: Bun.randomUUIDv7(),
        name: "edits.json",
        bytes,
    });
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        checkId = Bun.randomUUIDv7();
    const checked = daytonaEditContent(
        { id: checkId, commit: base, editsSha256: sha256 },
        { id: file.id, sha256 }
    );
    await f.client`INSERT INTO mira_daytona_jobs(id,owner,binding,binding_hash,content,content_hash,state,phase,cleanup,outcome,exit_code) VALUES (${checkId},${binding.owner},'{}'::jsonb,'synthetic',${JSON.stringify(checked)}::text::jsonb,'synthetic','completed','closed','confirmed','completed',0)`;
    await f.client`INSERT INTO mira_runtime_status(id,worker_id,version,ready,heartbeat_at,integrations) VALUES (1,${crypto.randomUUID()},'synthetic',true,now(),${JSON.stringify([{ owner: binding.owner, key: "github", bindingHash: githubBindingHash(binding), sendConfigured: true }])}::text::jsonb)`;
    await publishGitHubBinding(f.client, binding);
    const operations = { ...f, githubBinding: binding, miraFilesDirectory: directory };
    const api = appRouter.createCaller({
        operations,
        principal: { kind: "human", id: binding.owner, capabilities },
    }).mira;
    await api.controls.setEnabled({
        key: "integration:github",
        enabled: true,
        version: 1,
        reason: null,
        until: null,
    });
    const content = {
        checkId,
        commit: base,
        title: "fix(dashboard): improve display",
        body: "Reviewed change. Full checks completed in the selected cloud job.",
    };
    const save = (id = Bun.randomUUIDv7()) =>
        api.code.save({ id, version: 0, conversationId: null, content });
    const approve = (draft: MiraCodePublication) =>
        api.code.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
            reviewedContent: draft.content,
        });
    const dispatch = (provider: ReturnType<typeof githubProvider>) =>
        dispatchMiraCode(f.client, configuration, signal, directory, provider.request);
    return {
        ...f,
        directory,
        context,
        operations,
        api,
        content,
        save,
        approve,
        dispatch,
        file,
        checkId,
        checked,
        close: async () => {
            try {
                await f.close();
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        },
    };
}

test("code publication requires exact human review, verifies one tested input and serializes concurrent dispatch", async () => {
    const f = await fixture();
    try {
        const draft = await f.save(),
            provider = githubProvider(draft.id);
        expect(await f.dispatch(provider)).toBe(false);
        expect(provider.calls).toHaveLength(0);
        expect(await f.api.code.source({ id: draft.id })).toMatchObject({
            contentHash: draft.contentHash,
            plan: { version: 1, commit: base },
        });
        await rejects(
            f.api.code.approve({
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
                reviewedContent: { ...draft.content, body: "Changed" },
            }),
            /changed/
        );
        await rejects(
            approveMiraCode(
                { ...f.context, actor: "mira" },
                {
                    id: draft.id,
                    version: draft.version,
                    contentHash: draft.contentHash,
                    reviewedContent: draft.content,
                },
                binding,
                f.directory
            ),
            /operator/
        );
        await f.approve(draft);
        const dispatched = await Promise.all([
            f.dispatch(provider),
            f.dispatch(provider),
        ]);
        expect(dispatched.filter(Boolean)).toHaveLength(1);
        expect(await f.api.code.read({ id: draft.id })).toMatchObject({
            state: "published",
            number: 123,
            phase: "pull_request:confirmed",
        });
        expect(provider.calls.filter((call) => call.init.method === "POST")).toHaveLength(
            4
        );
        expect(await f.approve(draft)).toMatchObject({ state: "published" });
        expect(await f.dispatch(provider)).toBe(false);
        const second = await f.save();
        await rejects(f.approve(second), /already has/);
    } finally {
        await f.close();
    }
});

test("code proposals remain owner-scoped and initial retries or stale edits do not duplicate approval", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        expect(await f.save(draft.id)).toMatchObject({ id: draft.id });
        const other = appRouter.createCaller({
            operations: f.operations,
            principal: { kind: "human", id: "other", capabilities },
        }).mira;
        const hidden = await other.code.list({});
        expect(hidden.rows).toHaveLength(0);
        await rejects(other.code.read({ id: draft.id }));
        await rejects(other.code.source({ id: draft.id }));
        await rejects(
            other.code.save({
                id: draft.id,
                version: 0,
                conversationId: null,
                content: f.content,
            })
        );
        const updated = await f.api.code.save({
            id: draft.id,
            version: draft.version,
            conversationId: null,
            content: { ...f.content, title: "fix: revised title" },
        });
        await rejects(f.approve(draft), /changed/);
        expect(updated.version).toBe(2);
        await f.api.code.cancel({ id: updated.id, version: updated.version });
        expect(await f.api.code.read({ id: draft.id })).toMatchObject({
            state: "cancelled",
        });
    } finally {
        await f.close();
    }
});

for (const mode of [
    "failed",
    "pending-cleanup",
    "exit",
    "command",
    "base",
    "owner",
    "conversation",
] as const)
    test(`code proposals reject mismatched check ${mode}`, async () => {
        const f = await fixture();
        try {
            if (mode === "failed")
                await f.client`UPDATE mira_daytona_jobs SET state='failed',outcome='failed'`;
            if (mode === "pending-cleanup")
                await f.client`UPDATE mira_daytona_jobs SET cleanup='pending'`;
            if (mode === "exit") await f.client`UPDATE mira_daytona_jobs SET exit_code=1`;
            if (mode === "command")
                await f.client`UPDATE mira_daytona_jobs SET content=jsonb_set(content,'{command}','"true"'::jsonb)`;
            if (mode === "owner")
                await f.client`UPDATE mira_daytona_jobs SET owner='other'`;
            if (mode === "conversation") {
                const conversation = await f.api.conversations.create({ title: "Owned" });
                await f.client`UPDATE mira_daytona_jobs SET conversation_id=${conversation.id}`;
            }
            await rejects(
                f.api.code.save({
                    id: Bun.randomUUIDv7(),
                    version: 0,
                    conversationId: null,
                    content: {
                        ...f.content,
                        ...(mode === "base" ? { commit: "f".repeat(40) } : {}),
                    },
                })
            );
            const listing = await f.api.code.list({});
            expect(listing.rows).toHaveLength(0);
        } finally {
            await f.close();
        }
    });

for (const mode of ["deleted", "tampered"] as const)
    test(`selected edit file ${mode} prevents approval and queued dispatch`, async () => {
        const f = await fixture();
        try {
            const draft = await f.save();
            await f.approve(draft);
            if (mode === "deleted") {
                await rejects(
                    deleteMiraFile(f.context, f.directory, f.file.id),
                    /code publication/
                );
                await f.client`UPDATE mira_attachments SET deleted_at=now() WHERE id=${f.file.id}`;
            } else await writeFile(path.join(f.directory, f.file.id), "tampered");
            const provider = githubProvider(draft.id);
            expect(await f.dispatch(provider)).toBe(true);
            expect(provider.calls).toHaveLength(0);
            const current = await f.api.code.read({ id: draft.id });
            expect(current.state).toBe("draft");
            await rejects(f.approve(current));
        } finally {
            await f.close();
        }
    });

test("pause and expired or removed bindings revoke queued consent without provider calls", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        await f.approve(draft);
        await f.api.controls.setEnabled({
            key: "integration:github",
            enabled: false,
            version: 2,
            reason: "Away",
            until: null,
        });
        const provider = githubProvider(draft.id);
        expect(await f.dispatch(provider)).toBe(false);
        expect(provider.calls).toHaveLength(0);
        await reconcileMiraCode(f.client, configuration);
        expect(await f.api.code.read({ id: draft.id })).toMatchObject({ state: "draft" });
        await f.api.controls.setEnabled({
            key: "integration:github",
            enabled: true,
            version: 3,
            reason: null,
            until: null,
        });
        expect(await f.dispatch(provider)).toBe(false);
        await f.approve(await f.api.code.read({ id: draft.id }));
        await f.client`UPDATE mira_code_publications SET approved_at=now()-interval '16 minutes'`;
        await reconcileMiraCode(f.client, configuration);
        expect(await f.api.code.read({ id: draft.id })).toMatchObject({ state: "draft" });
        await f.approve(await f.api.code.read({ id: draft.id }));
        await reconcileMiraCode(f.client);
        expect(await f.api.code.read({ id: draft.id })).toMatchObject({ state: "draft" });
        expect(provider.calls).toHaveLength(0);
    } finally {
        await f.close();
    }
});

test("lost PR response preserves durable references and read-only inspection never republishes", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        await f.approve(draft);
        const provider = githubProvider(draft.id, (url, init, reply) => {
            const result = reply();
            if (init.method === "POST" && url.pathname.endsWith("/pulls"))
                throw new Error("private diagnostic");
            return result;
        });
        await f.dispatch(provider);
        const failed = await f.api.code.read({ id: draft.id });
        expect(failed).toMatchObject({
            state: "needs_attention",
            phase: "pull_request:sending",
            number: null,
        });
        expect(failed.commit).toBeTruthy();
        expect(failed.message).not.toContain("private diagnostic");
        expect(await f.dispatch(provider)).toBe(false);
        await f.api.code.inspect({ id: draft.id, version: failed.version });
        const before = provider.calls.length;
        const inspections = await Promise.all([
            inspectMiraCodeAttempt(f.client, configuration, signal, provider.request),
            inspectMiraCodeAttempt(f.client, configuration, signal, provider.request),
        ]);
        expect(inspections.filter(Boolean)).toHaveLength(1);
        expect(
            provider.calls.slice(before).every((call) => call.init.method === "GET")
        ).toBe(true);
        expect(await f.api.code.read({ id: draft.id })).toMatchObject({
            state: "needs_attention",
            inspectionRequested: false,
            observation: { pullRequest: { number: 123, draft: true } },
        });
        expect(provider.calls.filter((call) => call.init.method === "POST")).toHaveLength(
            4
        );
    } finally {
        await f.close();
    }
});

test("revocation after the first Git write stops later stages and preserves uncertainty", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        await f.approve(draft);
        const provider = githubProvider(draft.id, async (url, init, reply) => {
            const result = reply();
            if (init.method === "POST" && url.pathname.endsWith("/git/trees"))
                await f.api.controls.setEnabled({
                    key: "integration:github",
                    enabled: false,
                    version: 2,
                    reason: "Stop",
                    until: null,
                });
            return result;
        });
        await f.dispatch(provider);
        expect(await f.api.code.read({ id: draft.id })).toMatchObject({
            state: "needs_attention",
            phase: "tree:confirmed",
        });
        expect(provider.calls.filter((call) => call.init.method === "POST")).toHaveLength(
            1
        );
    } finally {
        await f.close();
    }
});

test("failed preflight returns to review while an abandoned started attempt never requeues", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        await f.approve(draft);
        const provider = githubProvider(
            draft.id,
            () => new Response("private", { status: 503 })
        );
        await f.dispatch(provider);
        let current = await f.api.code.read({ id: draft.id });
        expect(current.state).toBe("draft");
        expect(provider.calls.filter((call) => call.init.method === "POST")).toHaveLength(
            0
        );
        await f.approve(current);
        await f.client`UPDATE mira_code_publications SET state='publishing',attempt_token=${crypto.randomUUID()},started_at=now()-interval '4 minutes',phase='branch:sending'`;
        await reconcileMiraCode(f.client, configuration);
        current = await f.api.code.read({ id: draft.id });
        expect(current.state).toBe("needs_attention");
        expect(await f.dispatch(provider)).toBe(false);
        await f.api.code.inspect({ id: draft.id, version: current.version });
        await inspectMiraCodeAttempt(f.client, configuration, signal, provider.request);
        expect(await f.api.code.read({ id: draft.id })).toMatchObject({
            state: "needs_attention",
            inspectionRequested: false,
            observation: null,
        });
    } finally {
        await f.close();
    }
});

test("code tools create only a conversation-bound local draft with fenced receipts", async () => {
    const f = await fixture();
    try {
        const chat = await f.api.conversations.create({ title: "Code proposal" });
        await f.client`UPDATE mira_daytona_jobs SET conversation_id=${chat.id} WHERE id=${f.checkId}`;
        await f.api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Prepare a draft PR",
            attachmentIds: [],
        });
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(run).not.toBeNull();
        const tools = createMiraTools(
            f.client,
            run!,
            f.directory,
            undefined,
            undefined,
            undefined,
            undefined,
            binding
        );
        expect(
            tools.some((tool) => /code.*(approve|publish|merge)/.test(tool.name))
        ).toBe(false);
        const draft = tools.find((tool) => tool.name === "mira_code_draft")!;
        const call = { callId: "code-draft", threadId: "synthetic", turnId: "synthetic" };
        const input = { id: crypto.randomUUID(), version: 0, ...f.content };
        expect(JSON.parse(await draft.execute(input, signal, call))).toMatchObject({
            ok: true,
        });
        expect(JSON.parse(await draft.execute(input, signal, call))).toMatchObject({
            ok: false,
        });
        const listed = await f.api.code.list({ conversationId: chat.id });
        expect(listed.rows).toHaveLength(1);
        expect(listed.rows[0]).toMatchObject({ state: "draft", conversationId: chat.id });
        const list = tools.find((tool) => tool.name === "mira_code_proposals")!;
        expect(
            JSON.parse(await list.execute({}, signal, { ...call, callId: "list" }))
        ).toMatchObject({
            ok: true,
            result: { rows: [{ id: input.id, state: "draft" }] },
        });
        await f.api.controls.setEnabled({
            key: "integration:github",
            enabled: false,
            version: 2,
            reason: "Away",
            until: null,
        });
        expect(
            JSON.parse(
                await draft.execute({ ...input, id: crypto.randomUUID() }, signal, {
                    ...call,
                    callId: "paused",
                })
            )
        ).toMatchObject({ ok: false });
        expect(await f.dispatch(githubProvider(input.id))).toBe(false);
    } finally {
        await f.close();
    }
});

test("conversation deletion waits for queued publication and then scrubs local proposal content", async () => {
    const f = await fixture();
    try {
        const chat = await f.api.conversations.create({ title: "Private proposal" });
        await f.client`UPDATE mira_daytona_jobs SET conversation_id=${chat.id} WHERE id=${f.checkId}`;
        const draft = await f.api.code.save({
            id: crypto.randomUUID(),
            version: 0,
            conversationId: chat.id,
            content: f.content,
        });
        await f.approve(draft);
        await rejects(
            f.api.conversations.change({
                id: chat.id,
                version: 1,
                action: "delete",
            }),
            /code publication/
        );
        const queued = await f.api.code.read({ id: draft.id });
        await f.api.code.cancel({ id: queued.id, version: queued.version });
        await f.api.conversations.change({
            id: chat.id,
            version: 1,
            action: "delete",
        });
        const deleted = await f.api.code.read({ id: draft.id });
        expect(deleted).toMatchObject({
            state: "cancelled",
            contentHash: "",
            content: { title: "chore: deleted proposal", body: "Conversation deleted." },
            observation: null,
        });
        await rejects(f.api.code.source({ id: draft.id }));
        expect(await f.dispatch(githubProvider(draft.id))).toBe(false);
    } finally {
        await f.close();
    }
});
