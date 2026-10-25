import { expect, test, spyOn } from "bun:test";
import { rejects } from "node:assert/strict";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { capabilities } from "@homelab/contracts/operations";
import { saveMiraFile, deleteMiraFile } from "@homelab/mira/data/files";
import { publishAgentMailReceiver } from "@homelab/mira/data/integrations";
import { approveMiraMail, saveMiraMail } from "@homelab/mira/data/mail";
import { claimMiraRun } from "@homelab/mira/data/queue";
import { agentMailBindingHash } from "@homelab/mira/integrations/agentmail/configuration";
import {
    dispatchMiraMail,
    reconcileMiraMail,
} from "@homelab/mira/integrations/agentmail/outbox";
import { AgentMailReader } from "@homelab/mira/integrations/agentmail/reader";
import type { TransactionSQL } from "bun";
import { migrate } from "drizzle-orm/bun-sql/migrator";

import { createTestDatabase } from "../../../../../tests/database";
import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import { appRouter } from "../api/router";
import { connectDashboardDatabase } from "../database/connection";
import {
    dashboardMigrationsFolder,
    migrateDashboard,
    assertDashboardSchema,
} from "../database/migrations";
import { provisionTestAgentMail } from "../testing/agentmail";
import { operationFixture } from "../testing/operations";

const content = {
    to: ["recipient@example.com"],
    cc: ["copy@example.com"],
    bcc: ["private@example.com"],
    subject: "Synthetic review",
    text: "Only the explicitly approved text.",
};
const signal = new AbortController().signal;

async function mailFixture() {
    const fixture = await operationFixture();
    const binding = await provisionTestAgentMail(fixture.client);
    const configuration = {
        ...binding,
        apiKey: "synthetic-api-key-not-a-secret",
        sendApiKey: "synthetic-send-key-not-a-secret",
    };
    const caller = (owner = "operator", filesDirectory?: string) =>
        appRouter.createCaller({
            operations: {
                ...fixture,
                agentMailHook: binding,
                miraFilesDirectory: filesDirectory,
            },
            principal: { kind: "human", id: owner, capabilities },
        }).mira;
    const api = caller();
    await api.controls.list();
    await api.controls.setEnabled({
        key: "integration:agentmail",
        enabled: true,
        version: 1,
        reason: null,
        until: null,
    });
    const chat = await api.conversations.create({ title: "Mail qualification" });
    const create = () =>
        api.mail.save({
            id: crypto.randomUUID(),
            version: 0,
            conversationId: chat.id,
            content,
        });
    return { ...fixture, configuration, binding, api, caller, chat, create };
}

test("local drafts preserve ownership, exact version approval and idempotent retries without sending", async () => {
    const f = await mailFixture();
    try {
        const input = {
            id: crypto.randomUUID(),
            version: 0,
            conversationId: f.chat.id,
            content,
        };
        await rejects(
            f.api.mail.save({
                ...input,
                content: {
                    ...content,
                    to: Array.from(
                        { length: 20 },
                        (_, index) => `to-${index}@example.com`
                    ),
                    cc: Array.from(
                        { length: 20 },
                        (_, index) => `cc-${index}@example.com`
                    ),
                    bcc: Array.from(
                        { length: 11 },
                        (_, index) => `bcc-${index}@example.com`
                    ),
                },
            }),
            /at most 50 recipients/
        );
        const first = await f.api.mail.save(input);
        expect(await f.api.mail.save(input)).toEqual(first);
        expect(first).toMatchObject({ state: "draft", inboxId: f.binding.inboxId });
        const hidden = await f.caller("other").mail.list({});
        expect(hidden.rows).toHaveLength(0);
        await rejects(
            f.caller("other").mail.approve({
                id: first.id,
                version: first.version,
                contentHash: first.contentHash,
            })
        );
        await rejects(
            f.api.mail.save({
                ...input,
                content: { ...content, subject: "Changed retry" },
            }),
            /changed/
        );
        const changed = await f.api.mail.save({
            ...input,
            version: first.version,
            content: { ...content, text: "Reviewed new text" },
        });
        await rejects(
            f.api.mail.approve({
                id: first.id,
                version: first.version,
                contentHash: first.contentHash,
            }),
            /changed/
        );
        const approval = {
            id: changed.id,
            version: changed.version,
            contentHash: changed.contentHash,
        };
        const queued = await f.api.mail.approve(approval);
        expect(queued.state).toBe("queued");
        expect(await f.api.mail.approve(approval)).toEqual(queued);
        await rejects(f.api.mail.save({ ...input, version: queued.version }), /changed/);
        await rejects(
            approveMiraMail(
                { client: f.client, owner: "operator", actor: "mira:synthetic" },
                approval,
                f.binding
            ),
            /operator/
        );
        await f.api.mail.cancel({ id: queued.id, version: queued.version });
        const cancelled = await f.api.mail.approve(approval);
        expect(cancelled.state).toBe("cancelled");
        const never = Object.assign(
            () => Promise.reject(new Error("Provider must not be called")),
            { preconnect: fetch.preconnect }
        );
        expect(await dispatchMiraMail(f.client, f.configuration, signal, never)).toBe(
            false
        );
    } finally {
        await f.close();
    }
});

test("one reviewed send survives concurrent dispatch and lost approval responses without replay", async () => {
    const f = await mailFixture();
    try {
        const draft = await f.create();
        const approval = {
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
        };
        await f.api.mail.approve(approval);
        let calls = 0;
        const request = Object.assign(
            (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                calls++;
                expect(url).toBe(
                    `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(f.binding.inboxId)}/messages/send`
                );
                expect(init?.redirect).toBe("error");
                expect(init?.method).toBe("POST");
                if (typeof init?.body !== "string")
                    throw new Error("Expected serialized approved content");
                expect(JSON.parse(init.body) as unknown).toEqual({
                    ...content,
                    track_opens: false,
                });
                expect(new Headers(init?.headers).get("idempotency-key")).toBe(
                    `mira-mail-${draft.id}`
                );
                expect(new Headers(init?.headers).get("authorization")).toBe(
                    `Bearer ${f.configuration.sendApiKey}`
                );
                return Promise.resolve(
                    Response.json({
                        message_id: "accepted-message",
                        thread_id: "accepted-thread",
                    })
                );
            },
            { preconnect: fetch.preconnect }
        );
        const attempts = await Promise.all([
            dispatchMiraMail(f.client, f.configuration, signal, request),
            dispatchMiraMail(f.client, f.configuration, signal, request),
        ]);
        expect(attempts.toSorted()).toEqual([false, true]);
        expect(calls).toBe(1);
        const recovered = await f.api.mail.approve(approval);
        expect(recovered).toMatchObject({
            state: "sent",
            providerMessageId: "accepted-message",
        });
        expect(recovered.message).toContain("Recipient delivery is not yet confirmed");
        expect(await dispatchMiraMail(f.client, f.configuration, signal, request)).toBe(
            false
        );
        expect(calls).toBe(1);
    } finally {
        await f.close();
    }
});

for (const outcome of [
    "disconnect",
    "rejected",
    "invalid-response",
    "oversized-response",
] as const) {
    test(`mail ${outcome} remains uncertain and produces one private notification without resend`, async () => {
        const f = await mailFixture();
        try {
            const draft = await f.create();
            const approval = {
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
            };
            await f.api.mail.approve(approval);
            let calls = 0;
            const request = Object.assign(
                () => {
                    calls++;
                    if (outcome === "disconnect")
                        return Promise.reject(new Error("Secret provider diagnostic"));
                    if (outcome === "rejected")
                        return Promise.resolve(
                            new Response("Secret provider diagnostic", { status: 503 })
                        );
                    if (outcome === "oversized-response")
                        return Promise.resolve(new Response("x".repeat(65_537)));
                    return Promise.resolve(
                        Response.json({ message_id: "missing-thread" })
                    );
                },
                { preconnect: fetch.preconnect }
            );
            expect(
                await dispatchMiraMail(f.client, f.configuration, signal, request)
            ).toBe(true);
            const result = await f.api.mail.approve(approval);
            expect(result.state).toBe("needs_attention");
            expect(result.message).not.toContain("Secret");
            expect(
                await dispatchMiraMail(f.client, f.configuration, signal, request)
            ).toBe(false);
            await reconcileMiraMail(f.client);
            expect(calls).toBe(1);
            const notices = await f.client<
                { recipient: string }[]
            >`SELECT recipient FROM dashboard_notifications WHERE source='mira-mail'`;
            expect(notices).toEqual([{ recipient: "human:operator" }]);
            await rejects(
                f.api.mail.cancel({ id: result.id, version: result.version }),
                /already started/
            );
        } finally {
            await f.close();
        }
    });
}

for (const change of ["pause", "rebind", "expire", "receiver-offline"] as const) {
    test(`queued delivery revalidates ${change} before any provider call`, async () => {
        const f = await mailFixture();
        try {
            const draft = await f.create();
            await f.api.mail.approve({
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
            });
            if (change === "pause")
                await f.api.controls.setEnabled({
                    key: "integration:agentmail",
                    enabled: false,
                    version: 2,
                    reason: "Maintenance",
                    until: null,
                });
            if (change === "expire")
                await f.client`UPDATE mira_mail_drafts SET approved_at=now()-interval '16 minutes' WHERE id=${draft.id}`;
            if (change === "receiver-offline")
                await f.client`UPDATE mira_integration_receivers SET heartbeat_at=now()-interval '1 minute'`;
            const configuration =
                change === "rebind"
                    ? { ...f.configuration, inboxId: "replacement@example.com" }
                    : f.configuration;
            let calls = 0;
            const request = Object.assign(
                () => {
                    calls++;
                    return Promise.reject(new Error("Should not send"));
                },
                { preconnect: fetch.preconnect }
            );
            expect(await dispatchMiraMail(f.client, configuration, signal, request)).toBe(
                false
            );
            expect(calls).toBe(0);
            const page = await f.api.mail.list({});
            const [current] = page.rows;
            const expected = {
                "receiver-offline": "queued",
                rebind: "queued",
                pause: "draft",
                expire: "draft",
            } as const;
            expect(current?.state).toBe(expected[change]);
            if (change === "rebind") {
                await reconcileMiraMail(f.client, configuration);
                const queuedPage = await f.api.mail.list({});
                expect(queuedPage.rows[0]?.state).toBe("queued");
                await publishAgentMailReceiver(f.client, configuration);
                await reconcileMiraMail(f.client, configuration);
                const cancelledPage = await f.api.mail.list({});
                expect(cancelledPage.rows[0]?.state).toBe("cancelled");
            }
        } finally {
            await f.close();
        }
    });
}

test("a crashed sender is reconciled without resubmission even when its inbox is no longer configured", async () => {
    const f = await mailFixture();
    try {
        const draft = await f.create();
        await f.api.mail.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
        });
        await f.client`UPDATE mira_mail_drafts SET state='sending',attempt_token=${crypto.randomUUID()},started_at=now()-interval '3 minutes' WHERE id=${draft.id}`;
        await reconcileMiraMail(f.client);
        await reconcileMiraMail(f.client);
        const recovered = await f.api.mail.list({});
        expect(recovered.rows[0]?.state).toBe("needs_attention");
        expect(
            await f.client`SELECT id FROM dashboard_notifications WHERE source='mira-mail'`
        ).toHaveLength(1);
    } finally {
        await f.close();
    }
});

test("assistant tools can prepare owned drafts but expose no approval or send capability", async () => {
    const f = await mailFixture();
    try {
        const queued = await f.api.conversations.send({
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Prepare a synthetic email draft",
        });
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(run?.id).toBe(queued.id);
        const tools = createMiraTools(f.client, run!, undefined, f.configuration);
        expect(tools.some((tool) => /mail.*(?:approve|send)/.test(tool.name))).toBe(
            false
        );
        const create = tools.find((tool) => tool.name === "mira_mail_draft_create")!;
        const result: unknown = JSON.parse(
            await create.execute(content, signal, {
                callId: "draft-call",
                threadId: "synthetic",
                turnId: "synthetic",
            })
        );
        expect(result).toMatchObject({
            ok: true,
            result: { state: "draft", conversationId: f.chat.id },
        });
        await create.execute(content, signal, {
            callId: "draft-call",
            threadId: "synthetic",
            turnId: "synthetic",
        });
        const drafts = await f.api.mail.list({});
        expect(drafts.rows).toHaveLength(1);
        expect(
            await f.client`SELECT id FROM mira_tool_receipts WHERE state='succeeded'`
        ).toHaveLength(1);
        const automatic = createMiraTools(
            f.client,
            { ...run!, automationId: crypto.randomUUID() },
            undefined,
            f.configuration
        );
        const denied: unknown = JSON.parse(
            await automatic
                .find((tool) => tool.name === "mira_mail_draft_create")!
                .execute(content, signal, {
                    callId: "automatic",
                    threadId: "synthetic",
                    turnId: "synthetic",
                })
        );
        expect(denied).toMatchObject({ ok: false });
    } finally {
        await f.close();
    }
});

test("removing AgentMail clears queued approvals without credentials or provider calls", async () => {
    const f = await mailFixture();
    try {
        const draft = await f.create();
        await f.api.mail.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
        });
        await publishAgentMailReceiver(f.client);
        await reconcileMiraMail(f.client);
        const page = await f.api.mail.list({});
        expect(page.rows[0]).toMatchObject({
            state: "cancelled",
            inboxId: f.binding.inboxId,
            content,
        });
        expect(page.rows[0]?.message).toContain("cancelled before sending");
        const never = Object.assign(
            () => Promise.reject(new Error("Provider must not be called")),
            { preconnect: fetch.preconnect }
        );
        expect(await dispatchMiraMail(f.client, f.configuration, signal, never)).toBe(
            false
        );
        await reconcileMiraMail(f.client);
        const retained = await f.api.mail.list({});
        expect(retained.rows[0]?.version).toBe(page.rows[0]?.version);
    } finally {
        await f.close();
    }
});

test("reconciliation expires offline approvals and cancels obsolete inbox drafts without rebinding", async () => {
    const f = await mailFixture();
    try {
        const draft = await f.create();
        await f.api.mail.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
        });
        await f.client`UPDATE mira_mail_drafts SET approved_at=now()-interval '16 minutes' WHERE id=${draft.id}`;
        await f.client`UPDATE mira_integration_receivers SET heartbeat_at=now()-interval '1 minute'`;
        await reconcileMiraMail(f.client, f.configuration);
        const expired = await f.api.mail.list({});
        expect(expired.rows[0]?.state).toBe("draft");
        await reconcileMiraMail(f.client, {
            ...f.configuration,
            inboxId: "changed@example.com",
        });
        const draftPage = await f.api.mail.list({});
        expect(draftPage.rows[0]?.state).toBe("draft");
        await publishAgentMailReceiver(f.client, {
            ...f.binding,
            inboxId: "changed@example.com",
        });
        await reconcileMiraMail(f.client, {
            ...f.configuration,
            inboxId: "changed@example.com",
        });
        const obsolete = await f.api.mail.list({});
        expect(obsolete.rows[0]).toMatchObject({
            state: "cancelled",
            inboxId: f.binding.inboxId,
            content,
        });
        expect(obsolete.rows[0]?.message).toContain("Create a new draft");
        await rejects(
            f.api.mail.save({
                id: draft.id,
                version: obsolete.rows[0]!.version,
                conversationId: f.chat.id,
                content,
            }),
            /changed/
        );
    } finally {
        await f.close();
    }
});

test.each(["mira_mail_outbox", "mira_mail_reply_retry"] as const)(
    "%s migration upgrades its already migrated parent database",
    async (migration) => {
        const allocation = await createTestDatabase();
        const connection = connectDashboardDatabase(allocation.url);
        const prior = await mkdtemp(path.join(tmpdir(), "mira-parent-migrations-"));
        try {
            const source = dashboardMigrationsFolder();
            const entries = await readdir(source, { withFileTypes: true });
            const target = entries.find((entry) => entry.name.endsWith(`_${migration}`));
            if (!target) throw new Error("Expected mail migration");
            const parents = entries.filter(
                (entry) => entry.isDirectory() && entry.name < target.name
            );
            for (const entry of parents)
                await cp(path.join(source, entry.name), path.join(prior, entry.name), {
                    recursive: true,
                });
            await migrate(connection.database, { migrationsFolder: prior });
            const [before] = await connection.client<
                { name: string | null }[]
            >`SELECT to_regclass('public.mira_mail_drafts')::text AS name`;
            const retained = crypto.randomUUID();
            if (migration === "mira_mail_outbox") expect(before?.name).toBeNull();
            else {
                expect(before?.name).toBe("mira_mail_drafts");
                await connection.client`INSERT INTO mira_mail_drafts (id,owner,inbox_id,binding_hash,version,state,content,content_hash,approved_version,approved_by,approved_at,control_version) VALUES (${retained},'operator','synthetic@example.test','binding',2,'queued',${JSON.stringify(content)}::text::jsonb,'fingerprint',1,'human:operator',now(),1)`;
            }
            await migrateDashboard(connection);
            await assertDashboardSchema(connection);
            await migrateDashboard(connection);
            await assertDashboardSchema(connection);
            const [after] = await connection.client<
                { name: string | null }[]
            >`SELECT to_regclass('public.mira_mail_drafts')::text AS name`;
            expect(after?.name).toBe("mira_mail_drafts");
            if (migration === "mira_mail_reply_retry") {
                const [pending] = await connection.client<
                    {
                        state: string;
                        version: number;
                        approved: number;
                        retry: Date | null;
                        hash: string;
                        content: typeof content;
                    }[]
                >`SELECT state,version,approved_version AS approved,retry_after AS retry,content_hash AS hash,content FROM mira_mail_drafts WHERE id=${retained}`;
                expect(pending).toEqual({
                    state: "queued",
                    version: 2,
                    approved: 1,
                    retry: null,
                    hash: "fingerprint",
                    content,
                });
            }
        } finally {
            await connection.client.close();
            await allocation.close();
            await rm(prior, { recursive: true, force: true });
        }
    }
);

test("reviewed attachments send the exact owned bytes and retain durable fingerprints", async () => {
    const f = await mailFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-mail-files-"));
    const owner = {
        client: f.client,
        owner: f.binding.owner,
        actor: `human:${f.binding.owner}`,
    };
    try {
        const bytes = new TextEncoder().encode("Synthetic attachment contents");
        const file = await saveMiraFile(owner, directory, {
            id: crypto.randomUUID(),
            name: "report.txt",
            bytes,
        });
        const input = {
            id: crypto.randomUUID(),
            version: 0,
            conversationId: f.chat.id,
            content: { ...content, attachmentIds: [file.id] },
        };
        const draft = await f.api.mail.save(input);
        expect(draft.content.attachments).toMatchObject([
            {
                id: file.id,
                name: "report.txt",
                bytes: bytes.length,
                sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
            },
        ]);
        const plain = await f.create();
        expect(draft.contentHash).not.toBe(plain.contentHash);
        const legacyApproval = {
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
        };
        await rejects(
            f.caller("operator", directory).mail.approve(legacyApproval),
            /review every attachment/
        );
        await rejects(
            f.caller("operator", directory).mail.approve({
                ...legacyApproval,
                reviewedAttachments: [
                    { ...draft.content.attachments![0]!, mediaType: "application/pdf" },
                ],
            }),
            /review every attachment/
        );
        await f.caller("operator", directory).mail.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
            reviewedAttachments: draft.content.attachments,
        });
        let calls = 0;
        const request = Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                calls++;
                if (typeof init?.body !== "string")
                    throw new Error("Expected serialized content");
                expect(JSON.parse(init.body) as unknown).toEqual({
                    ...content,
                    track_opens: false,
                    attachments: [
                        {
                            filename: "report.txt",
                            content_type: "text/plain; charset=utf-8",
                            content: Buffer.from(bytes).toString("base64"),
                        },
                    ],
                });
                return Promise.resolve(
                    Response.json({
                        message_id: "sent-with-attachment",
                        thread_id: "thread",
                    })
                );
            },
            { preconnect: fetch.preconnect }
        );
        expect(
            await dispatchMiraMail(f.client, f.configuration, signal, request, directory)
        ).toBe(true);
        expect(calls).toBe(1);
        await deleteMiraFile(owner, directory, file.id);
        const retry = await f.api.mail.save(input);
        expect(retry.state).toBe("sent");
        expect(retry.contentHash).toBe(draft.contentHash);
        expect(
            await dispatchMiraMail(f.client, f.configuration, signal, request, directory)
        ).toBe(false);
    } finally {
        await f.close();
        await rm(directory, { recursive: true, force: true });
    }
});

for (const failure of [
    "deleted-before-approval",
    "missing-before-approval",
    "altered-before-approval",
    "deleted-after-approval",
    "altered-bytes",
] as const) {
    test(`email attachments fail closed when ${failure}`, async () => {
        const f = await mailFixture();
        const directory = await mkdtemp(path.join(tmpdir(), "mira-mail-files-"));
        const owner = {
            client: f.client,
            owner: f.binding.owner,
            actor: `human:${f.binding.owner}`,
        };
        try {
            const file = await saveMiraFile(owner, directory, {
                id: crypto.randomUUID(),
                name: "report.txt",
                bytes: new TextEncoder().encode("Original content"),
            });
            const draft = await f.api.mail.save({
                id: crypto.randomUUID(),
                version: 0,
                conversationId: f.chat.id,
                content: { ...content, attachmentIds: [file.id] },
            });
            if (failure.endsWith("before-approval")) {
                if (failure === "deleted-before-approval")
                    await deleteMiraFile(owner, directory, file.id);
                if (failure === "missing-before-approval")
                    await rm(path.join(directory, file.id));
                if (failure === "altered-before-approval")
                    await Bun.write(path.join(directory, file.id), "Tampered content");
                await rejects(
                    f.caller("operator", directory).mail.approve({
                        id: draft.id,
                        version: draft.version,
                        contentHash: draft.contentHash,
                        reviewedAttachments: draft.content.attachments,
                    }),
                    /available|could not be verified/
                );
            } else {
                await f.caller("operator", directory).mail.approve({
                    id: draft.id,
                    version: draft.version,
                    contentHash: draft.contentHash,
                    reviewedAttachments: draft.content.attachments,
                });
                await (failure === "deleted-after-approval"
                    ? deleteMiraFile(owner, directory, file.id)
                    : Bun.write(path.join(directory, file.id), "Tampered content"));
                let calls = 0;
                const request = Object.assign(
                    () => {
                        calls++;
                        return Promise.reject(new Error("Must not send"));
                    },
                    { preconnect: fetch.preconnect }
                );
                expect(
                    await dispatchMiraMail(
                        f.client,
                        f.configuration,
                        signal,
                        request,
                        directory
                    )
                ).toBe(false);
                expect(calls).toBe(0);
                const result = await f.api.mail.list({});
                expect(result.rows[0]?.state).toBe("draft");
                expect(result.rows[0]?.message).toContain(
                    "attachments could not be verified"
                );
            }
        } finally {
            await f.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}

test("attachment drafts reject foreign, oversized and duplicate files and models cannot inspect the whole library", async () => {
    const f = await mailFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-mail-files-"));
    const owner = {
        client: f.client,
        owner: f.binding.owner,
        actor: `human:${f.binding.owner}`,
    };
    try {
        const file = await saveMiraFile(owner, directory, {
            id: crypto.randomUUID(),
            name: "private.txt",
            bytes: new TextEncoder().encode("Only shared when selected"),
        });
        const input = (ids: string[]) => ({
            id: crypto.randomUUID(),
            version: 0,
            conversationId: f.chat.id,
            content: { ...content, attachmentIds: ids },
        });
        await rejects(
            f.caller("other").mail.save({ ...input([file.id]), conversationId: null }),
            /configured|available/
        );
        const foreign = await saveMiraFile(
            { ...owner, owner: "other", actor: "human:other" },
            directory,
            {
                id: crypto.randomUUID(),
                name: "foreign.txt",
                bytes: new TextEncoder().encode("Another owner's file"),
            }
        );
        await rejects(f.api.mail.save(input([foreign.id])), /available/);
        await rejects(f.api.mail.save(input([file.id, file.id])), /different/);
        const large = await saveMiraFile(owner, directory, {
            id: crypto.randomUUID(),
            name: "large.txt",
            bytes: new Uint8Array(4 * 1024 * 1024 + 1).fill(65),
        });
        await rejects(f.api.mail.save(input([large.id])), /4 MiB/);
        const shared = await saveMiraFile(owner, directory, {
            id: crypto.randomUUID(),
            name: "shared.txt",
            bytes: new TextEncoder().encode("Deliberately shared"),
        });
        await f.api.conversations.send({
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Prepare a draft using only the selected attachment",
            attachmentIds: [shared.id],
        });
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        const tool = createMiraTools(f.client, run!, directory, f.configuration).find(
            (item) => item.name === "mira_mail_draft_create"
        )!;
        const denied: unknown = JSON.parse(
            await tool.execute({ ...content, attachmentIds: [file.id] }, signal, {
                callId: "unshared",
                threadId: "test",
                turnId: "test",
            })
        );
        expect(denied).toMatchObject({ ok: false });
        expect(await f.client`SELECT id FROM mira_mail_drafts`).toHaveLength(0);
        const allowed: unknown = JSON.parse(
            await tool.execute({ ...content, attachmentIds: [shared.id] }, signal, {
                callId: "shared",
                threadId: "test",
                turnId: "test",
            })
        );
        expect(allowed).toMatchObject({
            ok: true,
            result: { content: { attachments: [{ id: shared.id }] } },
        });
    } finally {
        await f.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("removed receiver and credentials reconcile unapproved drafts and preserve their original binding", async () => {
    const f = await mailFixture();
    try {
        const draft = await f.create();
        await publishAgentMailReceiver(f.client);
        await reconcileMiraMail(f.client);
        const result = await f.api.mail.list({});
        expect(result.rows[0]).toMatchObject({
            id: draft.id,
            state: "cancelled",
            inboxId: f.binding.inboxId,
            content,
        });
        await reconcileMiraMail(f.client);
        const retained = await f.api.mail.list({});
        expect(retained.rows[0]?.version).toBe(result.rows[0]?.version);
    } finally {
        await f.close();
    }
});

test("read-only provisioning cannot approve or claim outgoing mail", async () => {
    const f = await mailFixture();
    try {
        const draft = await f.create();
        await f.client`UPDATE mira_runtime_status SET integrations=(SELECT jsonb_agg(value-'sendConfigured') FROM jsonb_array_elements(integrations))`;
        await rejects(
            f.api.mail.approve({
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
            }),
            /send credential/
        );
        const { sendApiKey: _key, ...readOnly } = f.configuration;
        let called = false;
        const request = Object.assign(
            () => {
                called = true;
                return Promise.reject(new Error("Must not send"));
            },
            { preconnect: fetch.preconnect }
        );
        expect(await dispatchMiraMail(f.client, readOnly, signal, request)).toBe(false);
        expect(called).toBe(false);
        const retained = await f.api.mail.list({});
        expect(retained.rows[0]?.state).toBe("draft");
    } finally {
        await f.close();
    }
});

test("removing only the send credential revokes an existing approval without cancelling the editable draft", async () => {
    const f = await mailFixture();
    try {
        const draft = await f.create();
        await f.api.mail.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
        });
        const { sendApiKey: _key, ...readOnly } = f.configuration;
        await reconcileMiraMail(f.client, readOnly);
        const result = await f.api.mail.list({});
        expect(result.rows[0]?.state).toBe("draft");
        expect(await dispatchMiraMail(f.client, f.configuration, signal)).toBe(false);
    } finally {
        await f.close();
    }
});

test("reapproving an expired email clears its obsolete review warning", async () => {
    const f = await mailFixture();
    try {
        const draft = await f.create();
        await f.api.mail.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
        });
        await f.client`UPDATE mira_mail_drafts SET approved_at=now()-interval '16 minutes' WHERE id=${draft.id}`;
        await reconcileMiraMail(f.client, f.configuration);
        const expiredPage = await f.api.mail.list({});
        const [expired] = expiredPage.rows;
        expect(expired?.state).toBe("draft");
        expect(expired?.message).toBeTruthy();
        const queued = await f.api.mail.approve({
            id: expired!.id,
            version: expired!.version,
            contentHash: expired!.contentHash,
        });
        expect(queued.state).toBe("queued");
        expect(queued.message).toBeNull();
    } finally {
        await f.close();
    }
});

test("deleting a chat retains editable owned drafts without admitting new deleted links", async () => {
    const f = await mailFixture();
    try {
        const draft = await f.create();
        await f.api.conversations.change({ id: f.chat.id, version: 1, action: "delete" });
        const edited = await f.api.mail.save({
            id: draft.id,
            version: draft.version,
            conversationId: f.chat.id,
            content: { ...content, text: "Edited after deleting its source chat" },
        });
        expect(edited.version).toBe(draft.version + 1);
        expect(edited.content.text).toContain("Edited after");
        await rejects(f.create(), /Conversation not found/);
        await rejects(
            f.caller("other").mail.save({
                id: draft.id,
                version: edited.version,
                conversationId: f.chat.id,
                content,
            }),
            /configured|not found/
        );
        const detached = await f.api.mail.save({
            id: draft.id,
            version: edited.version,
            conversationId: null,
            content: edited.content,
        });
        expect(detached.conversationId).toBeNull();
        await rejects(
            f.api.mail.save({
                id: draft.id,
                version: detached.version,
                conversationId: f.chat.id,
                content,
            }),
            /Conversation not found/
        );
    } finally {
        await f.close();
    }
});

test("reply drafts bind verified received-mail threads and retain them across operator edits", async () => {
    const f = await mailFixture();
    const read = spyOn(AgentMailReader.prototype, "read").mockResolvedValue({
        messageId: "<original@example.test>",
        threadId: "original-thread",
        from: "Original sender <sender@example.test>",
        replyTo: ["Replies <replies@example.test>"],
        to: ["mira@example.test"],
        cc: [],
        subject: "Original subject",
        format: "untrusted_text",
        content: "Untrusted source content",
        truncated: false,
        attachments: [],
    });
    const latest = spyOn(AgentMailReader.prototype, "latestMessageId")
        .mockResolvedValue("<original@example.test>")
        .mockResolvedValueOnce("newer-message");
    try {
        await f.api.conversations.send({
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Prepare a reply for review",
        });
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        if (!run) throw new Error("Expected run");
        const tool = createMiraTools(f.client, run, undefined, f.configuration).find(
            (entry) => entry.name === "mira_mail_reply_draft_create"
        )!;
        const input = {
            messageId: "<original@example.test>",
            to: ["reviewed@example.test"],
            text: "Reviewed reply",
        };
        const call = { callId: "reply", threadId: "synthetic", turnId: "synthetic" };
        const stale: unknown = JSON.parse(
            await tool.execute(input, signal, { ...call, callId: "stale" })
        );
        expect(stale).toMatchObject({ ok: false });
        const empty = await f.api.mail.list({});
        expect(empty.rows).toHaveLength(0);
        const result: unknown = JSON.parse(await tool.execute(input, signal, call));
        expect(result).toMatchObject({ ok: true, result: { state: "draft" } });
        const duplicate: unknown = JSON.parse(await tool.execute(input, signal, call));
        expect(duplicate).toMatchObject({ ok: false });
        expect(read).toHaveBeenCalledTimes(2);
        const page = await f.api.mail.list({});
        expect(page.rows).toHaveLength(1);
        const draft = page.rows[0]!;
        expect(draft.content).toMatchObject({
            to: input.to,
            subject: "Original subject",
            reply: {
                messageId: input.messageId,
                threadId: "original-thread",
                from: "Original sender <sender@example.test>",
                replyTo: ["Replies <replies@example.test>"],
                subject: "Original subject",
            },
        });
        const edit = {
            id: draft.id,
            version: draft.version,
            conversationId: f.chat.id,
            content: {
                ...content,
                to: input.to,
                subject: draft.content.subject,
                text: "Updated reply",
            },
        };
        await rejects(
            f.api.mail.save({
                ...edit,
                content: { ...edit.content, subject: "Changed thread subject" },
            }),
            /subject.*original email thread/
        );
        const updated = await f.api.mail.save(edit);
        expect(updated.content.reply).toEqual(draft.content.reply);
        expect(updated.contentHash).not.toBe(draft.contentHash);
        await rejects(
            saveMiraMail(
                { client: f.client, owner: "operator", actor: "human:operator" },
                { ...edit, version: updated.version },
                f.binding,
                { ...draft.content.reply!, threadId: "another-thread" }
            ),
            /cannot be moved/
        );
        const automatic = createMiraTools(
            f.client,
            { ...run, automationId: crypto.randomUUID() },
            undefined,
            f.configuration
        ).find((entry) => entry.name === tool.name)!;
        const denied: unknown = JSON.parse(
            await automatic.execute(input, signal, { ...call, callId: "automatic" })
        );
        expect(denied).toMatchObject({ ok: false });
        expect(read).toHaveBeenCalledTimes(2);
    } finally {
        read.mockRestore();
        latest.mockRestore();
        await f.close();
    }
});

test.each([true, false])(
    "reviewed replies use explicit recipients and verify the accepted thread (%s)",
    async (sameThread) => {
        const f = await mailFixture();
        try {
            const context = {
                client: f.client,
                owner: "operator",
                actor: "human:operator",
            };
            const input = {
                id: crypto.randomUUID(),
                version: 0,
                conversationId: f.chat.id,
                content,
            };
            const reply = {
                messageId: "<original@example.test>",
                threadId: "original-thread",
                from: "sender@example.test",
                subject: content.subject,
            };
            const draft = await saveMiraMail(context, input, f.binding, reply);
            expect(await saveMiraMail(context, input, f.binding, reply)).toEqual(draft);
            await rejects(saveMiraMail(context, input, f.binding), /changed/);
            const approval = {
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
                reviewedReply: draft.content.reply,
            };
            const { reviewedReply: _reply, ...legacyApproval } = approval;
            await rejects(f.api.mail.approve(legacyApproval), /original reply context/);
            await f.api.mail.approve(approval);
            let calls = 0;
            const request = Object.assign(
                (
                    url: Parameters<typeof fetch>[0],
                    init?: Parameters<typeof fetch>[1]
                ) => {
                    if (init?.method === "GET") {
                        expect(url instanceof Request ? url.url : String(url)).toBe(
                            `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(f.binding.inboxId)}/threads/original-thread?limit=1`
                        );
                        expect(new Headers(init.headers).get("authorization")).toBe(
                            `Bearer ${f.configuration.apiKey}`
                        );
                        return Promise.resolve(
                            Response.json({
                                inbox_id: f.binding.inboxId,
                                thread_id: reply.threadId,
                                last_message_id: reply.messageId,
                            })
                        );
                    }
                    calls++;
                    expect(url).toBe(
                        `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(f.binding.inboxId)}/messages/${encodeURIComponent(reply.messageId)}/reply`
                    );
                    expect(init?.redirect).toBe("error");
                    if (typeof init?.body !== "string")
                        throw new Error("Expected serialized reply");
                    const body: unknown = JSON.parse(init.body);
                    expect(body).toEqual({
                        to: content.to,
                        cc: content.cc,
                        bcc: content.bcc,
                        text: content.text,
                        reply_all: false,
                        track_opens: false,
                    });
                    return Promise.resolve(
                        Response.json({
                            message_id: "reply-message",
                            thread_id: sameThread ? reply.threadId : "unexpected-thread",
                        })
                    );
                },
                { preconnect: fetch.preconnect }
            );
            expect(
                await dispatchMiraMail(f.client, f.configuration, signal, request)
            ).toBe(true);
            expect(
                await dispatchMiraMail(f.client, f.configuration, signal, request)
            ).toBe(false);
            expect(calls).toBe(1);
            const outcome = await f.api.mail.approve(approval);
            expect(outcome.state).toBe(sameThread ? "sent" : "needs_attention");
            expect(outcome.providerMessageId).toBe("reply-message");
            expect(outcome.providerThreadId).toBe(
                sameThread ? reply.threadId : "unexpected-thread"
            );
        } finally {
            await f.close();
        }
    }
);

test.each(["removed", "changed", "offline"] as const)(
    "outbox reconciliation follows a %s dashboard receiver while the executor retains its old binding",
    async (change) => {
        const f = await mailFixture();
        try {
            const draft = await f.create(),
                queued = await f.create();
            await f.api.mail.approve({
                id: queued.id,
                version: queued.version,
                contentHash: queued.contentHash,
            });
            await (change === "offline"
                ? f.client`UPDATE mira_integration_receivers SET heartbeat_at=now()-interval '1 hour' WHERE key='agentmail'`
                : publishAgentMailReceiver(
                      f.client,
                      change === "removed"
                          ? undefined
                          : { ...f.binding, inboxId: "replacement@example.test" }
                  ));
            await reconcileMiraMail(f.client, f.configuration);
            const page = await f.api.mail.list({});
            expect(page.rows.find((row) => row.id === draft.id)?.state).toBe(
                change === "offline" ? "draft" : "cancelled"
            );
            expect(page.rows.find((row) => row.id === queued.id)?.state).toBe(
                change === "offline" ? "queued" : "cancelled"
            );
            let calls = 0;
            const request = Object.assign(
                () => {
                    calls++;
                    return Promise.reject(new Error("Unexpected send"));
                },
                { preconnect: fetch.preconnect }
            );
            expect(
                await dispatchMiraMail(f.client, f.configuration, signal, request)
            ).toBe(false);
            expect(calls).toBe(0);
        } finally {
            await f.close();
        }
    }
);

test("rolling inbox updates retain drafts for the receiver while the old executor waits", async () => {
    const f = await mailFixture();
    try {
        const old = await f.create();
        const replacement = { ...f.binding, inboxId: "replacement@example.test" };
        const context = { client: f.client, owner: "operator", actor: "human:operator" };
        await publishAgentMailReceiver(f.client, replacement);
        const input = {
            id: crypto.randomUUID(),
            version: 0,
            conversationId: f.chat.id,
            content,
        };
        const draft = await saveMiraMail(context, input, replacement);
        await reconcileMiraMail(f.client, f.configuration);
        await reconcileMiraMail(f.client);
        const page = await f.api.mail.list({});
        expect(page.rows.find((row) => row.id === old.id)?.state).toBe("cancelled");
        expect(page.rows.find((row) => row.id === draft.id)).toMatchObject({
            state: "draft",
            version: 1,
            inboxId: replacement.inboxId,
        });
        const edited = await saveMiraMail(
            context,
            { ...input, version: 1, content: { ...content, text: "Still editable" } },
            replacement
        );
        expect(edited.version).toBe(2);
        const binding = agentMailBindingHash(replacement);
        await f.client`UPDATE mira_switches SET binding_hash=${binding} WHERE key='integration:agentmail'`;
        await f.client`UPDATE mira_runtime_status SET integrations=${JSON.stringify([{ owner: replacement.owner, key: "agentmail", bindingHash: binding, sendConfigured: true }])}::text::jsonb`;
        const queued = await approveMiraMail(
            context,
            { id: edited.id, version: edited.version, contentHash: edited.contentHash },
            replacement
        );
        expect(queued.state).toBe("queued");
        let calls = 0;
        const request = Object.assign(
            () => {
                calls++;
                return Promise.reject(new Error("Old executor must not send"));
            },
            { preconnect: fetch.preconnect }
        );
        await reconcileMiraMail(f.client, f.configuration);
        expect(await dispatchMiraMail(f.client, f.configuration, signal, request)).toBe(
            false
        );
        expect(calls).toBe(0);
        const pending = await f.api.mail.list({});
        expect(pending.rows.find((row) => row.id === draft.id)?.state).toBe("queued");
    } finally {
        await f.close();
    }
});

test.each([
    ["missing", "expired"],
    ["missing", "disabled"],
    ["missing", "regranted"],
    ["previous", "expired"],
    ["previous", "disabled"],
    ["previous", "regranted"],
] as const)(
    "%s executor configuration still reconciles %s approvals for the current receiver",
    async (executorState, change) => {
        const f = await mailFixture();
        try {
            const draft = await f.create();
            const queued = await f.api.mail.approve({
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
            });
            const executor =
                executorState === "missing"
                    ? undefined
                    : { ...f.configuration, inboxId: "previous@example.test" };
            await reconcileMiraMail(f.client, executor);
            const pending = await f.api.mail.list({});
            expect(pending.rows[0]).toMatchObject({
                state: "queued",
                version: queued.version,
            });
            if (change === "expired")
                await f.client`UPDATE mira_mail_drafts SET approved_at=now()-interval '16 minutes' WHERE id=${draft.id}`;
            else if (change === "disabled")
                await f.client`UPDATE mira_switches SET enabled=false WHERE owner=${f.binding.owner} AND key='integration:agentmail'`;
            else
                await f.client`UPDATE mira_switches SET version=version+1 WHERE owner=${f.binding.owner} AND key='integration:agentmail'`;
            await reconcileMiraMail(f.client, executor);
            const [result] = await f.client<
                {
                    state: string;
                    version: number;
                    approved: number | null;
                    actor: string | null;
                    at: Date | null;
                    control: number | null;
                }[]
            >`SELECT state,version,approved_version AS approved,approved_by AS actor,approved_at AS at,control_version AS control FROM mira_mail_drafts WHERE id=${draft.id}`;
            expect(result).toEqual({
                state: "draft",
                version: queued.version + 1,
                approved: null,
                actor: null,
                at: null,
                control: null,
            });
            await reconcileMiraMail(f.client, executor);
            const restored = await f.api.mail.list({});
            expect(restored.rows[0]).toMatchObject({
                state: "draft",
                version: queued.version + 1,
                inboxId: f.binding.inboxId,
                content,
            });
        } finally {
            await f.close();
        }
    }
);

test("shutdown after claiming but before transport preserves a retryable approval", async () => {
    const f = await mailFixture();
    try {
        const draft = await f.create();
        await f.api.mail.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
        });
        const shutdown = new AbortController();
        const interrupted = new Proxy(f.client, {
            get(target, property, receiver) {
                if (property !== "begin")
                    return Reflect.get(target, property, receiver) as unknown;
                return async (callback: (query: TransactionSQL) => Promise<unknown>) => {
                    const result = await target.begin(callback);
                    shutdown.abort();
                    return result;
                };
            },
        });
        let calls = 0;
        const request = Object.assign(
            () => {
                calls++;
                return Promise.resolve(
                    Response.json({ message_id: "after-restart", thread_id: "thread" })
                );
            },
            { preconnect: fetch.preconnect }
        );
        expect(
            await dispatchMiraMail(interrupted, f.configuration, shutdown.signal, request)
        ).toBe(true);
        const pending = await f.api.mail.list({});
        expect(pending.rows[0]?.state).toBe("queued");
        expect(calls).toBe(0);
        const notices = await f.client<
            { id: string }[]
        >`SELECT id FROM dashboard_notifications WHERE source='mira-mail'`;
        expect(notices).toHaveLength(0);
        expect(await dispatchMiraMail(f.client, f.configuration, signal, request)).toBe(
            true
        );
        const sent = await f.api.mail.list({});
        expect(sent.rows[0]).toMatchObject({
            state: "sent",
            providerMessageId: "after-restart",
        });
        expect(calls).toBe(1);
    } finally {
        await f.close();
    }
});

test.each([
    "newer",
    "unavailable",
    "missing",
    "malformed",
    "timeout",
    "shutdown",
] as const)(
    "reply dispatch retains safe state when the latest thread is %s",
    async (condition) => {
        const f = await mailFixture();
        try {
            const draft = await saveMiraMail(
                { client: f.client, owner: "operator", actor: "human:operator" },
                {
                    id: crypto.randomUUID(),
                    version: 0,
                    conversationId: f.chat.id,
                    content,
                },
                f.binding,
                {
                    messageId: "selected",
                    threadId: "thread",
                    from: "sender@example.test",
                    subject: "Original",
                }
            );
            const queued = await f.api.mail.approve({
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
                reviewedReply: draft.content.reply,
            });
            let posts = 0;
            let recovered = false;
            const shutdown = new AbortController();
            const request = Object.assign(
                (
                    _url: Parameters<typeof fetch>[0],
                    init?: Parameters<typeof fetch>[1]
                ) => {
                    if (init?.method !== "GET") {
                        posts++;
                        return Promise.resolve(
                            Response.json({
                                message_id: "sent-reply",
                                thread_id: "thread",
                            })
                        );
                    }
                    if (recovered || condition === "newer")
                        return Promise.resolve(
                            Response.json({
                                inbox_id: f.binding.inboxId,
                                thread_id: "thread",
                                last_message_id: recovered ? "selected" : "newer",
                            })
                        );
                    if (condition === "timeout")
                        return Promise.reject(
                            new DOMException("Synthetic timeout", "TimeoutError")
                        );
                    if (condition === "shutdown") {
                        const stopped = new Error("Synthetic service shutdown");
                        shutdown.abort(stopped);
                        return Promise.reject(stopped);
                    }
                    return Promise.resolve(
                        condition === "malformed"
                            ? Response.json({ inbox_id: f.binding.inboxId })
                            : new Response("Sensitive upstream error", {
                                  status: condition === "missing" ? 404 : 503,
                              })
                    );
                },
                { preconnect: fetch.preconnect }
            );
            if (condition === "shutdown")
                await rejects(
                    dispatchMiraMail(f.client, f.configuration, shutdown.signal, request),
                    /Synthetic service shutdown/
                );
            else
                expect(
                    await dispatchMiraMail(f.client, f.configuration, signal, request)
                ).toBe(false);
            const page = await f.api.mail.list({});
            expect(page.rows[0]).toMatchObject({
                state: condition === "newer" ? "cancelled" : "queued",
                version: queued.version + (condition === "newer" ? 1 : 0),
            });
            const [attempt] = await f.client<
                { token: string | null; started: Date | null }[]
            >`SELECT attempt_token AS token,started_at AS started FROM mira_mail_drafts WHERE id=${draft.id}`;
            expect(attempt).toEqual({ token: null, started: null });
            expect(posts).toBe(0);
            if (condition !== "newer") {
                if (condition !== "shutdown") {
                    expect(
                        await dispatchMiraMail(f.client, f.configuration, signal, request)
                    ).toBe(false);
                    await f.client`UPDATE mira_mail_drafts SET retry_after=clock_timestamp()-interval '1 second' WHERE id=${draft.id}`;
                }
                recovered = true;
                expect(
                    await dispatchMiraMail(f.client, f.configuration, signal, request)
                ).toBe(true);
                expect(
                    await dispatchMiraMail(f.client, f.configuration, signal, request)
                ).toBe(false);
                const sent = await f.api.mail.list({});
                expect(sent.rows[0]).toMatchObject({
                    state: "sent",
                    providerMessageId: "sent-reply",
                });
                expect(posts).toBe(1);
            }
        } finally {
            await f.close();
        }
    }
);

test("a deferred reply does not block unrelated approved mail", async () => {
    const f = await mailFixture();
    try {
        const context = { client: f.client, owner: "operator", actor: "human:operator" };
        const blocked = await saveMiraMail(
            context,
            {
                id: "00000000-0000-4000-8000-000000000001",
                version: 0,
                conversationId: f.chat.id,
                content,
            },
            f.binding,
            {
                messageId: "selected",
                threadId: "thread",
                from: "sender@example.test",
                subject: "Original",
            }
        );
        const ordinary = await saveMiraMail(
            context,
            {
                id: "ffffffff-ffff-4fff-8fff-fffffffffff2",
                version: 0,
                conversationId: f.chat.id,
                content,
            },
            f.binding
        );
        for (const draft of [blocked, ordinary])
            await f.api.mail.approve({
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
                reviewedReply: draft.content.reply,
            });
        let reads = 0,
            posts = 0;
        const request = Object.assign(
            (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (init?.method === "GET") {
                    reads++;
                    return Promise.resolve(new Response(null, { status: 404 }));
                }
                posts++;
                expect(typeof url === "string" && url.endsWith("/messages/send")).toBe(
                    true
                );
                return Promise.resolve(
                    Response.json({
                        message_id: "ordinary-sent",
                        thread_id: "ordinary-thread",
                    })
                );
            },
            { preconnect: fetch.preconnect }
        );
        expect(await dispatchMiraMail(f.client, f.configuration, signal, request)).toBe(
            false
        );
        expect(await dispatchMiraMail(f.client, f.configuration, signal, request)).toBe(
            true
        );
        expect(await dispatchMiraMail(f.client, f.configuration, signal, request)).toBe(
            false
        );
        const page = await f.api.mail.list({});
        expect(page.rows.find((row) => row.id === blocked.id)?.state).toBe("queued");
        expect(page.rows.find((row) => row.id === ordinary.id)?.state).toBe("sent");
        expect(reads).toBe(1);
        expect(posts).toBe(1);
        await f.client`UPDATE mira_mail_drafts SET approved_at=clock_timestamp()-interval '16 minutes' WHERE id=${blocked.id}`;
        await reconcileMiraMail(f.client, f.configuration);
        const expired = await f.api.mail.list({});
        const draft = expired.rows.find((row) => row.id === blocked.id)!;
        expect(draft.state).toBe("draft");
        await f.api.mail.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
            reviewedReply: draft.content.reply,
        });
        expect(await dispatchMiraMail(f.client, f.configuration, signal, request)).toBe(
            false
        );
        expect(reads).toBe(2);
        expect(posts).toBe(1);
    } finally {
        await f.close();
    }
});

test("reply approval is checked against wall time after provider reads before claiming a send", async () => {
    const f = await mailFixture();
    try {
        const draft = await saveMiraMail(
            { client: f.client, owner: "operator", actor: "human:operator" },
            {
                id: crypto.randomUUID(),
                version: 0,
                conversationId: f.chat.id,
                content,
            },
            f.binding,
            {
                messageId: "selected",
                threadId: "thread",
                from: "sender@example.test",
                subject: "Original",
            }
        );
        await f.api.mail.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
            reviewedReply: draft.content.reply,
        });
        let activeQuery: TransactionSQL | undefined;
        const observed = new Proxy(f.client, {
            get(target, property, receiver) {
                if (property !== "begin")
                    return Reflect.get(target, property, receiver) as unknown;
                return (callback: (query: TransactionSQL) => Promise<unknown>) =>
                    target.begin(async (query) => {
                        activeQuery = query;
                        return callback(query);
                    });
            },
        });
        let reads = 0,
            posts = 0;
        const request = Object.assign(
            async (
                _url: Parameters<typeof fetch>[0],
                init?: Parameters<typeof fetch>[1]
            ) => {
                if (init?.method !== "GET") {
                    posts++;
                    return Response.json({
                        message_id: "must-not-send",
                        thread_id: "thread",
                    });
                }
                reads++;
                const query = activeQuery!;
                // Expire inside the existing transaction; now() would still consider it fresh.
                await query`UPDATE mira_mail_drafts SET approved_at=clock_timestamp()-interval '15 minutes'+interval '50 milliseconds' WHERE id=${draft.id}`;
                await query`SELECT pg_sleep(0.1)`;
                const [clock] = await query<
                    { transactionFresh: boolean; realFresh: boolean }[]
                >`SELECT approved_at>now()-interval '15 minutes' AS "transactionFresh",approved_at>clock_timestamp()-interval '15 minutes' AS "realFresh" FROM mira_mail_drafts WHERE id=${draft.id}`;
                expect(clock).toEqual({ transactionFresh: true, realFresh: false });
                return Response.json({
                    inbox_id: f.binding.inboxId,
                    thread_id: "thread",
                    last_message_id: "selected",
                });
            },
            { preconnect: fetch.preconnect }
        );
        expect(await dispatchMiraMail(observed, f.configuration, signal, request)).toBe(
            false
        );
        const [result] = await f.client<
            { state: string; token: string | null; approved: number | null }[]
        >`SELECT state,attempt_token AS token,approved_version AS approved FROM mira_mail_drafts WHERE id=${draft.id}`;
        expect(result).toEqual({ state: "draft", token: null, approved: null });
        expect(reads).toBe(1);
        expect(posts).toBe(0);
    } finally {
        await f.close();
    }
});
