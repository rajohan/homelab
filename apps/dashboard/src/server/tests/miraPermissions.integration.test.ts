import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { miraDefaultChatSettings } from "@homelab/contracts/mira";
import { capabilities } from "@homelab/contracts/operations";
import {
    miraActionApproval,
    miraRunPermission,
    requireMiraApproval,
} from "@homelab/mira/data/approvalPolicy";
import { saveMiraChatSettings } from "@homelab/mira/data/chatSettings";
import { readMiraMail, saveMiraMail } from "@homelab/mira/data/mail";
import { finishMiraRun } from "@homelab/mira/data/queue";
import {
    dispatchMiraMail,
    reconcileMiraMail,
} from "@homelab/mira/integrations/agentmail/outbox";

import { appRouter } from "../api/router";
import { provisionTestAgentMail } from "../testing/agentmail";
import { permissionRun } from "../testing/miraPermissions";
import { createMiraTextTestTools } from "../testing/miraTools";
import { operationFixture } from "../testing/operations";

const signal = new AbortController().signal;
const task = {
    title: "Permission test",
    description: "Requested synthetic work",
    status: "todo",
    assignee: "mira",
    priority: "normal",
    labels: [],
    dueAt: null,
    completionCriteria: "Verified",
    conversationId: null,
};
const mail = {
    to: ["recipient@example.test"],
    cc: [],
    bcc: [],
    subject: "Synthetic permission test",
    text: "Only a fake provider receives this.",
};

async function fixture(mode: "ask" | "approve_for_me" | "full_access") {
    const f = await operationFixture();
    const binding = await provisionTestAgentMail(f.client);
    const api = appRouter.createCaller({
        operations: { ...f, agentMailHook: binding },
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    await api.controls.setEnabled({
        key: "integration:agentmail",
        version: 1,
        enabled: true,
        reason: null,
        until: null,
    });
    const current = await permissionRun(f.client, api, mode);
    const configuration = {
        ...binding,
        apiKey: "synthetic-read",
        sendApiKey: "synthetic-send",
    };
    const tools = createMiraTextTestTools(
        f.client,
        current.run,
        undefined,
        configuration
    );
    const execute = async (name: string, input: unknown, callId = crypto.randomUUID()) =>
        JSON.parse(
            await tools
                .find((t) => t.name === name)!
                .execute(input, signal, {
                    callId,
                    threadId: "fixture",
                    turnId: "fixture",
                })
        ) as { ok: boolean; result?: { state?: string } };
    const draft = () =>
        saveMiraMail(
            { client: f.client, owner: "operator", actor: "human:operator" },
            {
                id: crypto.randomUUID(),
                version: 0,
                content: mail,
                conversationId: current.run.conversationId,
            },
            binding
        );
    const permission = async (mode: "ask" | "approve_for_me" | "full_access") => {
        const read = await api.conversations.read({ id: current.run.conversationId });
        await api.conversations.settings({
            id: current.run.conversationId,
            version: read.conversation.version,
            settings: { ...read.conversation.settings, permissionMode: mode },
        });
    };
    return { ...f, ...current, api, binding, configuration, execute, draft, permission };
}

for (const mode of ["ask", "approve_for_me", "full_access"] as const)
    test(`${mode} enforces task and external-action boundaries through real tool receipts`, async () => {
        const f = await fixture(mode);
        try {
            expect(await miraRunPermission(f.client, f.context)).toBe(mode);
            const result = await f.execute("mira_task_create", task);
            expect(result.ok).toBe(true);
            const tasks = await f.api.tasks.list({ search: "" });
            expect(tasks.rows.length).toBe(mode === "ask" ? 0 : 1);
            if (mode === "ask")
                expect(result).toMatchObject({ result: { state: "awaiting_approval" } });
            const draft = await f.draft();
            const input = {
                kind: "mail",
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
            };
            const callId = crypto.randomUUID();
            const sent = await f.execute("mira_action_execute", input, callId);
            expect(sent.ok).toBe(mode === "full_access");
            expect(await readMiraMail(f.client, "operator", draft.id)).toMatchObject({
                state: mode === "full_access" ? "queued" : "draft",
            });
            if (mode === "full_access") {
                expect(
                    await f.execute("mira_action_execute", input, callId)
                ).toMatchObject({ ok: false });
                const [receipt] = await f.client<
                    { origin: string; actor: string }[]
                >`SELECT approval_run_id AS origin,approved_by AS actor FROM mira_mail_drafts WHERE id=${draft.id}`;
                expect(receipt).toEqual({ origin: f.run.id, actor: `mira:${f.run.id}` });
                await finishMiraRun(f.client, f.run, {
                    state: "completed",
                    text: "Queued",
                    message: null,
                });
                let writes = 0;
                const request = Object.assign(
                    () => {
                        writes++;
                        return Promise.resolve(
                            Response.json({
                                message_id: "fixture-message",
                                thread_id: "fixture-thread",
                            })
                        );
                    },
                    { preconnect: fetch.preconnect }
                );
                expect(
                    await dispatchMiraMail(f.client, f.configuration, signal, request)
                ).toBe(true);
                expect(writes).toBe(1);
                expect(
                    await dispatchMiraMail(f.client, f.configuration, signal, request)
                ).toBe(false);
            }
        } finally {
            await f.close();
        }
    });

test("delegated authority cannot cross conversations, owners, actor identities or lease boundaries", async () => {
    const f = await fixture("full_access");
    try {
        const other = await f.api.conversations.create({ title: "Unrelated" });
        const draft = await f.api.mail.save({
            id: crypto.randomUUID(),
            version: 0,
            conversationId: other.id,
            content: mail,
        });
        expect(
            await f.execute("mira_action_execute", {
                kind: "mail",
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
            })
        ).toMatchObject({ ok: false });
        await rejects(
            saveMiraChatSettings(f.context, {
                id: f.run.conversationId,
                version: 1,
                settings: miraDefaultChatSettings,
            }),
            /Only the operator/
        );
        for (const context of [
            { ...f.context, owner: "other" },
            { ...f.context, actor: "human:operator" },
            { ...f.context, run: { id: f.run.id, leaseToken: crypto.randomUUID() } },
        ]) {
            expect(await miraRunPermission(f.client, context)).toBe("ask");
            await rejects(
                requireMiraApproval(f.client, context, f.run.conversationId, "external"),
                /requires/
            );
        }
        await f.client`UPDATE mira_runs SET lease_expires_at=now()-interval '1 second' WHERE id=${f.run.id}`;
        expect(await miraRunPermission(f.client, f.context)).toBe("ask");
        expect(await f.execute("mira_task_create", task)).toMatchObject({ ok: false });
    } finally {
        await f.close();
    }
});

for (const revoke of ["settings", "archive", "failed", "cancel"] as const)
    test(`queued delegated mail is not dispatched after ${revoke}`, async () => {
        const f = await fixture("full_access");
        try {
            const draft = await f.draft();
            expect(
                await f.execute("mira_action_execute", {
                    kind: "mail",
                    id: draft.id,
                    version: draft.version,
                    contentHash: draft.contentHash,
                })
            ).toMatchObject({ ok: true });
            await (revoke === "cancel"
                ? f.client`UPDATE mira_runs SET cancel_requested=true WHERE id=${f.run.id}`
                : finishMiraRun(f.client, f.run, {
                      state: revoke === "failed" ? "failed" : "completed",
                      text: "Synthetic",
                      message: null,
                  }));
            if (revoke === "settings") {
                await f.permission("ask");
                await f.permission("full_access");
            }
            if (revoke === "archive") {
                let read = await f.api.conversations.read({ id: f.run.conversationId });
                await f.api.conversations.change({
                    id: f.run.conversationId,
                    version: read.conversation.version,
                    action: "archive",
                });
                read = await f.api.conversations.read({ id: f.run.conversationId });
                await f.api.conversations.change({
                    id: f.run.conversationId,
                    version: read.conversation.version,
                    action: "restore",
                });
            }
            expect(await miraActionApproval(f.client, "operator", "mail", draft.id)).toBe(
                false
            );
            let writes = 0;
            const request = Object.assign(
                () => {
                    writes++;
                    return Promise.resolve(Response.json({}));
                },
                { preconnect: fetch.preconnect }
            );
            expect(
                await dispatchMiraMail(f.client, f.configuration, signal, request)
            ).toBe(false);
            expect(writes).toBe(0);
            expect(await readMiraMail(f.client, "operator", draft.id)).toMatchObject({
                state: "draft",
            });
            await reconcileMiraMail(f.client, f.configuration);
        } finally {
            await f.close();
        }
    });

test("automation runs do not inherit Chat delegation and explicit human approval remains independent", async () => {
    const f = await fixture("full_access");
    try {
        await f.client`UPDATE mira_runs SET manual=false WHERE id=${f.run.id}`;
        expect(await miraRunPermission(f.client, f.context)).toBe("ask");
        const draft = await f.draft();
        expect(
            await f.execute("mira_action_execute", {
                kind: "mail",
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
            })
        ).toMatchObject({ ok: false });
        await f.api.mail.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
        });
        expect(await miraActionApproval(f.client, "operator", "mail", draft.id)).toBe(
            true
        );
        expect(await miraActionApproval(f.client, "other", "mail", draft.id)).toBe(false);
    } finally {
        await f.close();
    }
});
