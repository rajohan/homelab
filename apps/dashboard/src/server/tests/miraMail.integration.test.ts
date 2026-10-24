import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { capabilities } from "@homelab/contracts/operations";
import { approveMiraMail } from "@homelab/mira/data/mail";
import { claimMiraRun } from "@homelab/mira/data/queue";
import {
    dispatchMiraMail,
    reconcileMiraMail,
} from "@homelab/mira/integrations/agentmail/outbox";
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
    const configuration = { ...binding, apiKey: "synthetic-api-key-not-a-secret" };
    const caller = (owner = "operator") =>
        appRouter.createCaller({
            operations: { ...fixture, agentMailHook: binding },
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
                    `Bearer ${f.configuration.apiKey}`
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
                rebind: "cancelled",
                pause: "draft",
                expire: "draft",
            } as const;
            expect(current?.state).toBe(expected[change]);
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

test("outbox migration upgrades an already migrated parent database", async () => {
    const allocation = await createTestDatabase();
    const connection = connectDashboardDatabase(allocation.url);
    const prior = await mkdtemp(path.join(tmpdir(), "mira-parent-migrations-"));
    try {
        const source = dashboardMigrationsFolder();
        const entries = await readdir(source, { withFileTypes: true });
        const outbox = entries.find((entry) => entry.name.endsWith("_mira_mail_outbox"));
        if (!outbox) throw new Error("Expected outbox migration");
        const parents = entries.filter(
            (entry) => entry.isDirectory() && entry.name !== outbox.name
        );
        expect(parents.every((entry) => entry.name < outbox.name)).toBe(true);
        for (const entry of parents)
            await cp(path.join(source, entry.name), path.join(prior, entry.name), {
                recursive: true,
            });
        await migrate(connection.database, { migrationsFolder: prior });
        const [before] = await connection.client<
            { name: string | null }[]
        >`SELECT to_regclass('public.mira_mail_drafts')::text AS name`;
        expect(before?.name).toBeNull();
        await migrateDashboard(connection);
        await assertDashboardSchema(connection);
        await migrateDashboard(connection);
        await assertDashboardSchema(connection);
        const [after] = await connection.client<
            { name: string | null }[]
        >`SELECT to_regclass('public.mira_mail_drafts')::text AS name`;
        expect(after?.name).toBe("mira_mail_drafts");
    } finally {
        await connection.client.close();
        await allocation.close();
        await rm(prior, { recursive: true, force: true });
    }
});
