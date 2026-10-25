import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import type { MiraSocialDraft, MiraSocialContent } from "@homelab/contracts/miraSocial";
import { capabilities } from "@homelab/contracts/operations";
import { publishMoltbookBinding } from "@homelab/mira/data/moltbook";
import { claimMiraRun } from "@homelab/mira/data/queue";
import { approveMiraSocial, verifyMiraSocial } from "@homelab/mira/data/social";
import { moltbookBindingHash } from "@homelab/mira/integrations/moltbook/configuration";
import {
    dispatchMiraSocial,
    reconcileMiraSocial,
} from "@homelab/mira/integrations/moltbook/outbox";

import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

const binding = { owner: "operator", agentName: "SyntheticMira" };
const configuration = {
    ...binding,
    apiKey: "synthetic-read-credential",
    publishApiKey: "synthetic-publish-credential",
};
function body(init?: RequestInit): string {
    if (typeof init?.body !== "string") throw new Error("Expected string body");
    return init.body;
}
const signal = new AbortController().signal;
async function fixture() {
    const f = await operationFixture();
    const context = {
        client: f.client,
        owner: binding.owner,
        actor: `human:${binding.owner}`,
    };
    await f.client`INSERT INTO mira_runtime_status(id,worker_id,version,ready,heartbeat_at,integrations) VALUES(1,${crypto.randomUUID()},'synthetic',true,now(),${JSON.stringify(["moltbook", "moltbook-publish"].map((key) => ({ owner: binding.owner, key, bindingHash: moltbookBindingHash(binding), sendConfigured: key === "moltbook-publish" })))}::text::jsonb)`;
    await publishMoltbookBinding(f.client, binding);
    const operations = { ...f, moltbookBinding: binding };
    const api = appRouter.createCaller({
        operations,
        principal: { kind: "human", id: binding.owner, capabilities },
    }).mira;
    for (const key of ["integration:moltbook", "integration:moltbook-publish"])
        await api.controls.setEnabled({
            key,
            enabled: true,
            version: 1,
            reason: null,
            until: null,
        });
    const defaultContent: MiraSocialContent = {
        kind: "post",
        community: "testing",
        title: "Reviewed title",
        text: "Exact body",
    };
    const save = (content: MiraSocialContent = defaultContent, id = Bun.randomUUIDv7()) =>
        api.social.save({ id, version: 0, conversationId: null, content });
    const approve = (draft: MiraSocialDraft) =>
        api.social.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
            reviewedContent: draft.content,
        });
    const read = async (id: string) => {
        const page = await api.social.list({});
        return page.rows.find((row) => row.id === id)!;
    };
    const pause = async (key = "integration:moltbook-publish") => {
        const controls = await api.controls.list();
        const control = controls.find((x) => x.key === key)!;
        await api.controls.setEnabled({
            key,
            enabled: false,
            version: control.version,
            reason: "Operator pause",
            until: null,
        });
    };
    return { ...f, context, operations, api, save, approve, read, pause };
}
function provider(
    options: {
        pending?: boolean;
        post?: () => Response | Promise<Response>;
        profile?: () => Response | Promise<Response>;
        verify?: () => Response | Promise<Response>;
    } = {}
) {
    const calls: { url: URL; init: RequestInit | undefined }[] = [];
    const expires = new Date(Date.now() + 120_000).toISOString();
    const request = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = new URL(input instanceof Request ? input.url : input);
            calls.push({ url, init });
            if (url.pathname.endsWith("/agents/me"))
                return options.profile
                    ? await options.profile()
                    : Response.json({
                          success: true,
                          agent: { name: binding.agentName },
                      });
            if (url.pathname.endsWith("/verify"))
                return options.verify
                    ? await options.verify()
                    : Response.json({
                          success: true,
                          content_type: "post",
                          content_id: "post-1",
                      });
            if (options.post) return await options.post();
            const kind = url.pathname.endsWith("/comments") ? "comment" : "post";
            return Response.json({
                success: true,
                [kind]: {
                    id: kind === "post" ? "post-1" : "comment-1",
                    verification_status: options.pending ? "pending" : "verified",
                    ...(options.pending
                        ? {
                              verification: {
                                  verification_code: "private-code",
                                  challenge_text: "Synthetic challenge",
                                  expires_at: expires,
                              },
                          }
                        : {}),
                },
            });
        },
        { preconnect: fetch.preconnect }
    );
    return {
        calls,
        request,
        expires,
        writes: () => calls.filter((x) => x.init?.method === "POST"),
    };
}
test("Moltbook requires exact human approval and concurrent dispatch sends once", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        const p = provider();
        expect(await dispatchMiraSocial(f.client, configuration, signal, p.request)).toBe(
            false
        );
        expect(p.calls).toHaveLength(0);
        await rejects(
            f.api.social.approve({
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
                reviewedContent: { ...draft.content, text: "Different" },
            }),
            /changed/
        );
        await rejects(
            approveMiraSocial(
                { ...f.context, actor: "mira:synthetic" },
                {
                    id: draft.id,
                    version: draft.version,
                    contentHash: draft.contentHash,
                    reviewedContent: draft.content,
                },
                binding
            ),
            /operator/
        );
        await f.approve(draft);
        const results = await Promise.all([
            dispatchMiraSocial(f.client, configuration, signal, p.request),
            dispatchMiraSocial(f.client, configuration, signal, p.request),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(p.writes()).toHaveLength(1);
        expect(await f.read(draft.id)).toMatchObject({
            state: "submitted",
            providerId: "post-1",
        });
        expect(await f.approve(draft)).toMatchObject({ state: "submitted" });
        expect(await dispatchMiraSocial(f.client, configuration, signal, p.request)).toBe(
            false
        );
        await rejects(
            f.api.social.save({
                id: draft.id,
                version: draft.version + 3,
                conversationId: null,
                content: { ...draft.content, text: "edit" },
            }),
            /changed/
        );
    } finally {
        await f.close();
    }
});
test("Moltbook pending content waits for one operator answer and never recreates the post", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        await f.approve(draft);
        const p = provider({ pending: true });
        await dispatchMiraSocial(f.client, configuration, signal, p.request);
        const pending = await f.read(draft.id);
        expect(pending).toMatchObject({
            state: "verification_required",
            providerId: "post-1",
            challenge: "Synthetic challenge",
        });
        expect(JSON.stringify(pending)).not.toContain("private-code");
        expect(await dispatchMiraSocial(f.client, configuration, signal, p.request)).toBe(
            false
        );
        await rejects(
            verifyMiraSocial(
                { ...f.context, actor: "mira:synthetic" },
                { id: pending.id, version: pending.version, answer: "15.00" },
                binding
            ),
            /operator/
        );
        await f.api.social.verify({
            id: pending.id,
            version: pending.version,
            answer: "15.00",
        });
        await rejects(
            f.api.social.verify({
                id: pending.id,
                version: pending.version,
                answer: "15.00",
            }),
            /already advanced/
        );
        await dispatchMiraSocial(f.client, configuration, signal, p.request);
        expect(await f.read(draft.id)).toMatchObject({
            state: "submitted",
            providerId: "post-1",
        });
        expect(p.writes().map((x) => x.url.pathname)).toEqual([
            "/api/v1/posts",
            "/api/v1/verify",
        ]);
        expect(JSON.parse(body(p.writes()[1]!.init))).toEqual({
            verification_code: "private-code",
            answer: "15.00",
        });
        const [stored] = await f.client<
            { code: string | null; answer: string | null }[]
        >`SELECT verification_code AS code,answer FROM mira_social_drafts WHERE id=${draft.id}`;
        expect(stored).toEqual({ code: null, answer: null });
    } finally {
        await f.close();
    }
});
test.each(["wrong", "expired", "unknown", "rate-limited"])(
    "Moltbook %s verification never retries or recreates content",
    async (mode) => {
        const f = await fixture();
        try {
            const draft = await f.save();
            await f.approve(draft);
            const p = provider({
                pending: true,
                verify: () => {
                    if (mode === "unknown") throw new Error("lost acknowledgement");
                    return Response.json(
                        { success: false, error: "private error" },
                        {
                            status:
                                (
                                    { expired: 410, "rate-limited": 429 } as Record<
                                        string,
                                        number
                                    >
                                )[mode] ?? 400,
                        }
                    );
                },
            });
            await dispatchMiraSocial(f.client, configuration, signal, p.request);
            const pending = await f.read(draft.id);
            await f.api.social.verify({
                id: draft.id,
                version: pending.version,
                answer: "15.00",
            });
            await dispatchMiraSocial(f.client, configuration, signal, p.request);
            expect(await f.read(draft.id)).toMatchObject({
                state: "needs_attention",
                providerId: "post-1",
            });
            await reconcileMiraSocial(f.client, configuration);
            expect(
                await dispatchMiraSocial(f.client, configuration, signal, p.request)
            ).toBe(false);
            expect(p.writes()).toHaveLength(2);
            expect(JSON.stringify(await f.read(draft.id))).not.toContain("private error");
        } finally {
            await f.close();
        }
    }
);
test.each(["integration:moltbook", "integration:moltbook-publish"])(
    "Moltbook pause %s independently revokes queued publication",
    async (key) => {
        const f = await fixture();
        try {
            const draft = await f.save();
            await f.approve(draft);
            await f.pause(key);
            const p = provider();
            await reconcileMiraSocial(f.client, configuration);
            expect(await f.read(draft.id)).toMatchObject({ state: "draft" });
            expect(
                await dispatchMiraSocial(f.client, configuration, signal, p.request)
            ).toBe(false);
            expect(p.calls).toHaveLength(0);
            const controls = await f.api.controls.list();
            const control = controls.find((x) => x.key === key)!;
            await f.api.controls.setEnabled({
                key,
                enabled: true,
                version: control.version,
                reason: null,
                until: null,
            });
            expect(
                await dispatchMiraSocial(f.client, configuration, signal, p.request)
            ).toBe(false);
            await f.approve(await f.read(draft.id));
            await dispatchMiraSocial(f.client, configuration, signal, p.request);
            expect(p.writes()).toHaveLength(1);
        } finally {
            await f.close();
        }
    }
);
test.each([
    "configuration removed",
    "credential removed",
    "account changed",
    "approval expired",
    "runtime stale",
    "dashboard stale",
])("Moltbook revokes %s without contacting the provider", async (mode) => {
    const f = await fixture();
    try {
        const draft = await f.save();
        await f.approve(draft);
        let config: typeof configuration | undefined = configuration;
        if (mode === "configuration removed") config = undefined;
        if (mode === "credential removed")
            config = { ...configuration, publishApiKey: "" };
        if (mode === "account changed")
            await publishMoltbookBinding(f.client, {
                ...binding,
                agentName: "Different",
            });
        if (mode === "approval expired")
            await f.client`UPDATE mira_social_drafts SET approved_at=now()-interval '16 minutes'`;
        if (mode === "runtime stale")
            await f.client`UPDATE mira_runtime_status SET heartbeat_at=now()-interval '1 minute'`;
        if (mode === "dashboard stale")
            await f.client`UPDATE mira_integration_receivers SET heartbeat_at=now()-interval '1 minute'`;
        await reconcileMiraSocial(f.client, config);
        expect(await f.read(draft.id)).toMatchObject({ state: "draft" });
        const p = provider();
        expect(await dispatchMiraSocial(f.client, configuration, signal, p.request)).toBe(
            false
        );
        expect(p.calls).toHaveLength(0);
    } finally {
        await f.close();
    }
});
test.each(["pause", "expire", "cancel"])(
    "Moltbook rechecks %s after identity preflight",
    async (mode) => {
        const f = await fixture();
        try {
            const draft = await f.save();
            await f.approve(draft);
            const p = provider({
                profile: async () => {
                    if (mode === "pause") await f.pause();
                    if (mode === "expire")
                        await f.client`UPDATE mira_social_drafts SET approved_at=now()-interval '16 minutes'`;
                    if (mode === "cancel") {
                        const queued = await f.read(draft.id);
                        await f.api.social.cancel({
                            id: queued.id,
                            version: queued.version,
                        });
                    }
                    return Response.json({
                        success: true,
                        agent: { name: binding.agentName },
                    });
                },
            });
            expect(
                await dispatchMiraSocial(f.client, configuration, signal, p.request)
            ).toBe(false);
            expect(p.writes()).toHaveLength(0);
        } finally {
            await f.close();
        }
    }
);
test("Moltbook validates publication credential identity and failed preflight does not block other queued drafts", async () => {
    const f = await fixture();
    try {
        const first = await f.save();
        const second = await f.save({ ...first.content, text: "Second" });
        await f.approve(first);
        await f.approve(second);
        const wrong = provider({
            profile: () =>
                Response.json({ success: true, agent: { name: "WrongAgent" } }),
        });
        expect(
            await dispatchMiraSocial(f.client, configuration, signal, wrong.request)
        ).toBe(false);
        expect(wrong.writes()).toHaveLength(0);
        const p = provider();
        expect(await dispatchMiraSocial(f.client, configuration, signal, p.request)).toBe(
            true
        );
        expect(await f.read(second.id)).toMatchObject({ state: "submitted" });
        expect(await f.read(first.id)).toMatchObject({ state: "queued" });
    } finally {
        await f.close();
    }
});
test("Moltbook known rate limits defer the account and expire old approvals without write replay", async () => {
    const f = await fixture();
    try {
        const first = await f.save();
        const second = await f.save({ ...first.content, text: "Second" });
        await f.approve(first);
        await f.approve(second);
        const p = provider({
            post: () =>
                Response.json(
                    { success: false },
                    { status: 429, headers: { "Retry-After": "60" } }
                ),
        });
        expect(await dispatchMiraSocial(f.client, configuration, signal, p.request)).toBe(
            true
        );
        expect(await f.read(first.id)).toMatchObject({ state: "queued" });
        expect(await dispatchMiraSocial(f.client, configuration, signal, p.request)).toBe(
            false
        );
        expect(p.writes()).toHaveLength(1);
        await f.client`UPDATE mira_social_cooldowns SET until=now()-interval '1 second'`;
        await f.client`UPDATE mira_social_drafts SET retry_after=NULL,approved_at=now()-interval '16 minutes'`;
        await reconcileMiraSocial(f.client, configuration);
        const drafts = await f.api.social.list({});
        expect(drafts.rows.every((row) => row.state === "draft")).toBe(true);
        expect(await dispatchMiraSocial(f.client, configuration, signal, p.request)).toBe(
            false
        );
    } finally {
        await f.close();
    }
});
test.each(["expired", "paused", "cancelled"])(
    "Moltbook pending challenge %s keeps content identity without another post",
    async (mode) => {
        const f = await fixture();
        try {
            const draft = await f.save();
            await f.approve(draft);
            const p = provider({ pending: true });
            await dispatchMiraSocial(f.client, configuration, signal, p.request);
            const pending = await f.read(draft.id);
            if (mode === "expired")
                await f.client`UPDATE mira_social_drafts SET expires_at=now()-interval '1 second'`;
            if (mode === "paused") await f.pause();
            if (mode === "cancelled")
                await f.api.social.cancel({ id: pending.id, version: pending.version });
            await rejects(
                f.api.social.verify({
                    id: pending.id,
                    version: pending.version,
                    answer: "15.00",
                })
            );
            await reconcileMiraSocial(f.client, configuration);
            expect(await f.read(draft.id)).toMatchObject({
                providerId: "post-1",
                state: mode === "cancelled" ? "cancelled" : "needs_attention",
            });
            expect(
                await dispatchMiraSocial(f.client, configuration, signal, p.request)
            ).toBe(false);
            expect(p.writes()).toHaveLength(1);
        } finally {
            await f.close();
        }
    }
);
test("Moltbook recovery never retries ambiguous requests and retains known references", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        await f.approve(draft);
        await f.client`UPDATE mira_social_drafts SET state='publishing',attempt_token=${crypto.randomUUID()},started_at=now()-interval '3 minutes',provider_id='known-post'`;
        await reconcileMiraSocial(f.client, configuration);
        const p = provider();
        expect(await dispatchMiraSocial(f.client, configuration, signal, p.request)).toBe(
            false
        );
        expect(await f.read(draft.id)).toMatchObject({
            state: "needs_attention",
            providerId: "known-post",
        });
        expect(p.calls).toHaveLength(0);
        const other = await f.save();
        await f.approve(other);
        const lost = provider({
            post: () => {
                throw new Error("uncertain write");
            },
        });
        await dispatchMiraSocial(f.client, configuration, signal, lost.request);
        expect(await f.read(other.id)).toMatchObject({
            state: "needs_attention",
            providerId: null,
        });
        expect(
            await dispatchMiraSocial(f.client, configuration, signal, lost.request)
        ).toBe(false);
        expect(lost.writes()).toHaveLength(1);
    } finally {
        await f.close();
    }
});
test("Moltbook drafts are owner scoped, version checked and same-ID creation retries do not duplicate", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        expect(await f.save(draft.content, draft.id)).toEqual(draft);
        const other = appRouter.createCaller({
            operations: f.operations,
            principal: { kind: "human", id: "someone-else", capabilities },
        }).mira;
        const others = await other.social.list({});
        expect(others.rows).toHaveLength(0);
        await rejects(other.social.cancel({ id: draft.id, version: draft.version }));
        await rejects(
            other.social.approve({
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
                reviewedContent: draft.content,
            })
        );
        const edited = await f.api.social.save({
            id: draft.id,
            version: draft.version,
            conversationId: null,
            content: { ...draft.content, text: "Edited" },
        });
        expect(edited.version).toBe(draft.version + 1);
        await rejects(f.approve(draft), /changed/);
        await f.api.social.cancel({ id: edited.id, version: edited.version });
        expect(await f.read(draft.id)).toMatchObject({ state: "cancelled" });
    } finally {
        await f.close();
    }
});
test("Moltbook replies retain the reviewed post and parent and submit only a comment", async () => {
    const f = await fixture();
    try {
        const draft = await f.save({
            kind: "comment",
            postId: "target-post",
            parentId: "target-parent",
            text: "Reviewed reply",
        });
        await f.approve(draft);
        const p = provider();
        await dispatchMiraSocial(f.client, configuration, signal, p.request);
        expect(await f.read(draft.id)).toMatchObject({
            state: "submitted",
            providerId: "comment-1",
        });
        expect(p.writes()[0]!.url.pathname).toBe("/api/v1/posts/target-post/comments");
        expect(JSON.parse(body(p.writes()[0]!.init))).toEqual({
            content: "Reviewed reply",
            parent_id: "target-parent",
        });
    } finally {
        await f.close();
    }
});

test("Moltbook model drafts are conversation scoped, receipt-idempotent and cannot approve or verify", async () => {
    const f = await fixture();
    try {
        const chat = await f.api.conversations.create({ title: "Prepare a post" });
        await f.api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Prepare a local post draft",
        });
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(run).not.toBeNull();
        const tools = createMiraTools(
            f.client,
            run!,
            undefined,
            undefined,
            configuration
        );
        expect(
            tools.some((tool) => /moltbook.*(approve|verify|publish)/.test(tool.name))
        ).toBe(false);
        const tool = tools.find((entry) => entry.name === "mira_moltbook_draft")!;
        const input = {
            id: crypto.randomUUID(),
            version: 0,
            content: {
                kind: "post",
                community: "testing",
                title: "Model draft",
                text: "Proposed exact body",
            },
        };
        const invocation = {
            callId: "draft-once",
            threadId: "synthetic",
            turnId: "synthetic",
        };
        expect(JSON.parse(await tool.execute(input, signal, invocation))).toMatchObject({
            ok: true,
        });
        expect(JSON.parse(await tool.execute(input, signal, invocation))).toMatchObject({
            ok: false,
        });
        const page = await f.api.social.list({ conversationId: chat.id });
        expect(page.rows).toHaveLength(1);
        expect(page.rows[0]).toMatchObject({ state: "draft", conversationId: chat.id });
        const list = tools.find((entry) => entry.name === "mira_moltbook_drafts")!;
        const listed = JSON.parse(
            await list.execute({}, signal, { ...invocation, callId: "list" })
        ) as { ok: boolean; result: { rows: unknown[] } };
        expect(listed.ok).toBe(true);
        expect(listed.result.rows[0]).not.toHaveProperty("challenge");
        await f.pause();
        expect(
            JSON.parse(
                await tool.execute({ ...input, id: crypto.randomUUID() }, signal, {
                    ...invocation,
                    callId: "paused",
                })
            )
        ).toMatchObject({ ok: false });
        await f.client`UPDATE mira_runs SET lease_expires_at=now()-interval '1 second' WHERE id=${run!.id}`;
        expect(
            JSON.parse(
                await tool.execute({ ...input, id: crypto.randomUUID() }, signal, {
                    ...invocation,
                    callId: "expired",
                })
            )
        ).toMatchObject({ ok: false });
    } finally {
        await f.close();
    }
});
