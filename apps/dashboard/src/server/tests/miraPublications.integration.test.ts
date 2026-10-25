import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
    MiraPublication,
    MiraPublicationInput,
} from "@homelab/contracts/miraPublication";
import { capabilities } from "@homelab/contracts/operations";
import { saveMiraFile, deleteMiraFile } from "@homelab/mira/data/files";
import { publishHereNowBinding } from "@homelab/mira/data/herenow";
import { approveMiraPublication } from "@homelab/mira/data/publications";
import { claimMiraRun } from "@homelab/mira/data/queue";
import { hereNowBindingHash } from "@homelab/mira/integrations/herenow/configuration";
import {
    dispatchMiraPublication,
    reconcileMiraPublications,
} from "@homelab/mira/integrations/herenow/outbox";

import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import { publicationProvider } from "../../../../mira/src/server/testing/herenow";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

const binding = { owner: "operator", accountId: "11111111-1111-4111-8111-111111111111" };
const configuration = {
    ...binding,
    apiKey: "synthetic-read-credential",
    publishApiKey: "synthetic-publish-credential",
};
const bytes = new TextEncoder().encode("<h1>Reviewed page</h1>");
const signal = new AbortController().signal;
async function fixture() {
    const f = await operationFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-publication-"));
    const context = {
        client: f.client,
        owner: binding.owner,
        actor: `human:${binding.owner}`,
    };
    const file = await saveMiraFile(context, directory, {
        id: Bun.randomUUIDv7(),
        name: "page.html",
        bytes,
    });
    await f.client`INSERT INTO mira_runtime_status(id,worker_id,version,ready,heartbeat_at,integrations) VALUES (1,${crypto.randomUUID()},'synthetic',true,now(),${JSON.stringify([{ owner: binding.owner, key: "here-now", bindingHash: hereNowBindingHash(binding), sendConfigured: true }])}::text::jsonb)`;
    await publishHereNowBinding(f.client, binding);
    const operations = { ...f, hereNowBinding: binding, miraFilesDirectory: directory };
    const api = appRouter.createCaller({
        operations,
        principal: { kind: "human", id: binding.owner, capabilities },
    }).mira;
    await api.controls.setEnabled({
        key: "integration:here-now",
        enabled: true,
        version: 1,
        reason: null,
        until: null,
    });
    const save = (content?: Partial<MiraPublicationInput>, id = Bun.randomUUIDv7()) =>
        api.publications.save({
            id,
            version: 0,
            conversationId: null,
            content: {
                title: "Reviewed site",
                target: null,
                visibility: "anyone_with_link",
                files: [{ id: file.id, path: "index.html" }],
                ...content,
            },
        });
    const approve = (draft: MiraPublication) =>
        api.publications.approve({
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
            reviewedContent: draft.content,
        });
    const read = async (id: string) => {
        const result = await api.publications.list({});
        return result.rows.find((row) => row.id === id)!;
    };
    return {
        ...f,
        directory,
        context,
        file,
        operations,
        api,
        save,
        approve,
        read,
        close: async () => {
            try {
                await f.close();
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        },
    };
}

test("publication requires exact human approval, commits a verified result and never repeats delivery", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        const provider = publicationProvider(draft.content);
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(false);
        expect(provider.calls).toHaveLength(0);
        await rejects(
            f.api.publications.approve({
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
                reviewedContent: { ...draft.content, title: "Different" },
            }),
            /changed/
        );
        await f.approve(draft);
        const results = await Promise.all([
            dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            ),
            dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            ),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await f.read(draft.id)).toMatchObject({
            state: "published",
            slug: "synthetic-site",
            providerVersionId: "version-new",
        });
        expect(
            provider.calls.filter(
                (call) =>
                    call.method === "POST" && call.url.pathname === "/api/v1/publish"
            )
        ).toHaveLength(1);
        const calls = provider.calls.length;
        expect(await f.approve(draft)).toMatchObject({ state: "published" });
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(false);
        expect(provider.calls).toHaveLength(calls);
    } finally {
        await f.close();
    }
});

test("publication drafts and approvals remain owner-scoped and draft retries preserve one record", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        expect(await f.save(undefined, draft.id)).toMatchObject({ id: draft.id });
        const other = appRouter.createCaller({
            operations: f.operations,
            principal: { kind: "human", id: "other", capabilities },
        }).mira;
        const hidden = await other.publications.list({});
        expect(hidden.rows).toHaveLength(0);
        await rejects(
            other.publications.approve({
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
                reviewedContent: draft.content,
            })
        );
        await rejects(
            f.save({ files: [{ id: crypto.randomUUID(), path: "index.html" }] }),
            /available/
        );
        await rejects(
            f.save({
                files: [
                    { id: f.file.id, path: "index.html" },
                    { id: f.file.id, path: "copy.html" },
                ],
            }),
            /different/
        );
        const listing = await f.api.publications.list({});
        expect(listing.rows).toHaveLength(1);
    } finally {
        await f.close();
    }
});

test("editing a draft invalidates the old review and MIME mismatches are rejected", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        const updated = await f.api.publications.save({
            id: draft.id,
            version: draft.version,
            conversationId: null,
            content: {
                ...draft.content,
                title: "Changed title",
                files: [{ id: f.file.id, path: "index.html" }],
            },
        });
        await rejects(f.approve(draft), /changed/);
        expect(updated.version).toBe(2);
        await rejects(
            f.save({ files: [{ id: f.file.id, path: "image.png" }] }),
            /extension/
        );
    } finally {
        await f.close();
    }
});

test("pause before dispatch prevents even preflight reads and requires fresh approval after resume", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        await f.approve(draft);
        await f.api.controls.setEnabled({
            key: "integration:here-now",
            enabled: false,
            version: 2,
            reason: "Away",
            until: null,
        });
        const provider = publicationProvider(draft.content);
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(false);
        expect(provider.calls).toHaveLength(0);
        await reconcileMiraPublications(f.client, configuration);
        expect(await f.read(draft.id)).toMatchObject({ state: "draft" });
        await f.api.controls.setEnabled({
            key: "integration:here-now",
            enabled: true,
            version: 3,
            reason: null,
            until: null,
        });
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(false);
        await f.approve(await f.read(draft.id));
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(true);
    } finally {
        await f.close();
    }
});

for (const change of ["pause", "remove", "shutdown"] as const)
    test(`publication stops later external steps after ${change} during staging`, async () => {
        const f = await fixture();
        const stopping = new AbortController();
        try {
            const draft = await f.save();
            await f.approve(draft);
            const provider = publicationProvider(draft.content, async (call) => {
                if (call.method !== "POST" || call.url.pathname !== "/api/v1/publish")
                    return;
                if (change === "pause")
                    await f.api.controls.setEnabled({
                        key: "integration:here-now",
                        enabled: false,
                        version: 2,
                        reason: "Stop",
                        until: null,
                    });
                else if (change === "remove") await publishHereNowBinding(f.client);
                else stopping.abort();
            });
            expect(
                await dispatchMiraPublication(
                    f.client,
                    configuration,
                    stopping.signal,
                    f.directory,
                    provider.request
                )
            ).toBe(true);
            expect(await f.read(draft.id)).toMatchObject({
                state: "needs_attention",
                slug: "synthetic-site",
                providerVersionId: "version-new",
            });
            expect(provider.state.uploads).toBe(0);
            expect(
                provider.calls.some((call) => call.url.pathname.endsWith("/finalize"))
            ).toBe(false);
        } finally {
            await f.close();
        }
    });

test("deleting a selected file during upload prevents finalization", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        await f.approve(draft);
        const provider = publicationProvider(draft.content, async (call) => {
            if (call.url.hostname.endsWith(".r2.cloudflarestorage.com"))
                await deleteMiraFile(f.context, f.directory, f.file.id);
        });
        await dispatchMiraPublication(
            f.client,
            configuration,
            signal,
            f.directory,
            provider.request
        );
        expect(await f.read(draft.id)).toMatchObject({ state: "needs_attention" });
        expect(
            provider.calls.some((call) => call.url.pathname.endsWith("/finalize"))
        ).toBe(false);
    } finally {
        await f.close();
    }
});

test("lost creation acknowledgements are redacted, durable and not automatically retried", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        await f.approve(draft);
        const provider = publicationProvider(draft.content, (call) => {
            if (call.method === "POST")
                throw new Error("private provider credential diagnostics");
        });
        await dispatchMiraPublication(
            f.client,
            configuration,
            signal,
            f.directory,
            provider.request
        );
        const outcome = await f.read(draft.id);
        expect(outcome.state).toBe("needs_attention");
        expect(outcome.message).not.toContain("private provider");
        const calls = provider.calls.length;
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(false);
        expect(provider.calls).toHaveLength(calls);
    } finally {
        await f.close();
    }
});

test("changed files cannot be approved or uploaded after approval", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        await writeFile(path.join(f.directory, f.file.id), "changed");
        await rejects(f.approve(draft), /verified/);
        await writeFile(path.join(f.directory, f.file.id), bytes);
        await f.approve(draft);
        await writeFile(path.join(f.directory, f.file.id), "changed again");
        const provider = publicationProvider(draft.content);
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(false);
        expect(provider.calls.every((call) => call.method === "GET")).toBe(true);
        expect(await f.read(draft.id)).toMatchObject({ state: "draft" });
    } finally {
        await f.close();
    }
});

for (const change of ["expiry", "cancel"] as const)
    test(`${change} during preflight prevents publication admission`, async () => {
        const f = await fixture();
        try {
            const draft = await f.save();
            const queued = await f.approve(draft);
            const provider = publicationProvider(draft.content, async (call) => {
                if (!call.url.pathname.endsWith("/accounts")) return;
                await (change === "expiry"
                    ? f.client`UPDATE mira_publications SET approved_at=now()-interval '16 minutes' WHERE id=${draft.id}`
                    : f.api.publications.cancel({
                          id: draft.id,
                          version: queued.version,
                      }));
            });
            expect(
                await dispatchMiraPublication(
                    f.client,
                    configuration,
                    signal,
                    f.directory,
                    provider.request
                )
            ).toBe(false);
            expect(provider.calls.every((call) => call.method === "GET")).toBe(true);
            await reconcileMiraPublications(f.client, configuration);
            expect(await f.read(draft.id)).toMatchObject({
                state: change === "expiry" ? "draft" : "cancelled",
            });
        } finally {
            await f.close();
        }
    });

test("failed preflight defers one draft while another approved publication proceeds", async () => {
    const f = await fixture();
    try {
        const first = await f.save(undefined, "10000000-0000-4000-8000-000000000001");
        const second = await f.save(undefined, "10000000-0000-4000-8000-000000000002");
        await f.approve(first);
        await f.approve(second);
        let failed = false;
        const provider = publicationProvider(second.content, (call): Response | void => {
            if (!failed && call.url.pathname.endsWith("/accounts")) {
                failed = true;
                return new Response("private", { status: 503 });
            }
        });
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(false);
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(true);
        expect(await f.read(first.id)).toMatchObject({ state: "queued" });
        expect(await f.read(second.id)).toMatchObject({ state: "published" });
    } finally {
        await f.close();
    }
});

test("stale target version returns to draft without changing the existing site", async () => {
    const f = await fixture();
    try {
        const draft = await f.save({
            target: { slug: "owned-site", baseVersionId: "version-old" },
        });
        await f.approve(draft);
        const provider = publicationProvider(draft.content);
        provider.state.current = "changed-after-review";
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(false);
        expect(await f.read(draft.id)).toMatchObject({ state: "draft" });
        expect(provider.calls.every((call) => call.method === "GET")).toBe(true);
    } finally {
        await f.close();
    }
});

test("account replacement cancels queued publication and interrupted attempts remain visible", async () => {
    const f = await fixture();
    try {
        const interrupted = await f.save();
        await f.approve(interrupted);
        await f.client`UPDATE mira_publications SET state='publishing',attempt_token=${crypto.randomUUID()},started_at=now()-interval '4 minutes',slug='known-site',provider_version_id='known-version' WHERE id=${interrupted.id}`;
        const queued = await f.save();
        await f.approve(queued);
        await publishHereNowBinding(f.client, {
            ...binding,
            accountId: "33333333-3333-4333-8333-333333333333",
        });
        await reconcileMiraPublications(f.client, configuration);
        await reconcileMiraPublications(f.client, configuration);
        expect(await f.read(interrupted.id)).toMatchObject({
            state: "needs_attention",
            slug: "known-site",
            providerVersionId: "known-version",
        });
        expect(await f.read(queued.id)).toMatchObject({ state: "cancelled" });
    } finally {
        await f.close();
    }
});

test("stale runtime and a missing publishing credential cannot authorize outbound work", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        await f.approve(draft);
        const provider = publicationProvider(draft.content);
        const { publishApiKey: _key, ...readOnly } = configuration;
        expect(
            await dispatchMiraPublication(
                f.client,
                readOnly,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(false);
        await f.client`UPDATE mira_runtime_status SET heartbeat_at=now()-interval '1 minute'`;
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(false);
        expect(provider.calls).toHaveLength(0);
    } finally {
        await f.close();
    }
});

test("a second approved publication waits while the account has an active upload", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let firstAttempt: Promise<boolean> | undefined;
    try {
        const first = await f.save(undefined, "10000000-0000-4000-8000-000000000001");
        const second = await f.save(undefined, "10000000-0000-4000-8000-000000000002");
        await f.approve(first);
        await f.approve(second);
        const provider = publicationProvider(first.content, async (call) => {
            if (call.method === "POST" && call.url.pathname === "/api/v1/publish") {
                entered.resolve();
                await release.promise;
            }
        });
        firstAttempt = dispatchMiraPublication(
            f.client,
            configuration,
            signal,
            f.directory,
            provider.request
        );
        await entered.promise;
        const calls = provider.calls.length;
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(false);
        expect(provider.calls).toHaveLength(calls);
        expect(await f.read(second.id)).toMatchObject({ state: "queued" });
        release.resolve();
        expect(await firstAttempt).toBe(true);
        const next = publicationProvider(second.content);
        expect(
            await dispatchMiraPublication(
                f.client,
                configuration,
                signal,
                f.directory,
                next.request
            )
        ).toBe(true);
        expect(await f.read(second.id)).toMatchObject({ state: "published" });
    } finally {
        release.resolve();
        await firstAttempt;
        await f.close();
    }
});

test("model drafts use only this conversation's files and cannot approve or bypass pause and lease loss", async () => {
    const f = await fixture();
    try {
        const chat = await f.api.conversations.create({ title: "Prepare publication" });
        await f.api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Prepare a public page from this attachment",
            attachmentIds: [f.file.id],
        });
        const claimed = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(claimed).not.toBeNull();
        const tools = createMiraTools(
            f.client,
            claimed!,
            f.directory,
            undefined,
            undefined,
            configuration
        );
        expect(tools.some((tool) => /publication.*approve/.test(tool.name))).toBe(false);
        const tool = tools.find(
            (entry) => entry.name === "mira_herenow_publication_draft"
        )!;
        const invoke = async (fileId: string, callId: string) =>
            JSON.parse(
                await tool.execute(
                    {
                        id: crypto.randomUUID(),
                        version: 0,
                        content: {
                            title: "Proposed page",
                            target: null,
                            visibility: "anyone_with_link",
                            files: [{ id: fileId, path: "index.html" }],
                        },
                    },
                    signal,
                    { callId, threadId: "synthetic", turnId: "synthetic" }
                )
            ) as { ok: boolean };
        const unshared = await saveMiraFile(f.context, f.directory, {
            id: crypto.randomUUID(),
            name: "unshared.html",
            bytes,
        });
        expect(await invoke(unshared.id, "unshared")).toMatchObject({ ok: false });
        expect(await invoke(f.file.id, "shared")).toMatchObject({ ok: true });
        const records = await f.api.publications.list({ conversationId: chat.id });
        expect(records.rows).toHaveLength(1);
        const draft = records.rows[0]!;
        expect(draft.state).toBe("draft");
        await rejects(
            approveMiraPublication(
                {
                    ...f.context,
                    actor: `mira:${claimed!.id}`,
                    run: { id: claimed!.id, leaseToken: claimed!.leaseToken },
                },
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
        await f.api.controls.setEnabled({
            key: "integration:here-now",
            enabled: false,
            version: 2,
            reason: "Paused",
            until: null,
        });
        expect(await invoke(f.file.id, "paused")).toMatchObject({ ok: false });
        await f.api.controls.setEnabled({
            key: "integration:here-now",
            enabled: true,
            version: 3,
            reason: null,
            until: null,
        });
        await f.client`UPDATE mira_runs SET lease_expires_at=now()-interval '1 second' WHERE id=${claimed!.id}`;
        expect(await invoke(f.file.id, "expired")).toMatchObject({ ok: false });
        const remaining = await f.api.publications.list({});
        expect(remaining.rows).toHaveLength(1);
    } finally {
        await f.close();
    }
});
