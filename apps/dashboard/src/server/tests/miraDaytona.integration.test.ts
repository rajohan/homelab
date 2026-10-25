import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { MiraDaytonaContent, MiraDaytonaJob } from "@homelab/contracts/miraDaytona";
import { capabilities } from "@homelab/contracts/operations";
import { resumeMiraControls } from "@homelab/mira/data/automations";
import {
    approveMiraDaytona,
    publishDaytonaBinding,
    saveMiraDaytona,
} from "@homelab/mira/data/daytona";
import { deleteMiraFile, saveMiraFile, readMiraFile } from "@homelab/mira/data/files";
import { claimMiraRun } from "@homelab/mira/data/queue";
import {
    daytonaBindingHash,
    daytonaExecutionConfiguration,
    daytonaSandboxName,
} from "@homelab/mira/integrations/daytona/configuration";
import { dispatchMiraDaytona } from "@homelab/mira/integrations/daytona/jobs";

import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

const configuration = {
    owner: "operator",
    trustBoundary: "dedicated-organization" as const,
    networkAccess: "provider-default" as const,
    organizationId: "11111111-1111-4111-8111-111111111111",
    snapshotId: "22222222-2222-4222-8222-222222222222",
    target: "eu",
    apiKey: "synthetic-daytona-secret",
    executionQualified: true,
};
const sandboxId = "44444444-4444-4444-8444-444444444444";
const signal = new AbortController().signal;
const defaultContent: MiraDaytonaContent = {
    title: "Synthetic command",
    command: "bun --version",
    inputs: [],
    outputs: [],
};
async function fixture() {
    const f = await operationFixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-daytona-test-"));
    const context = {
        client: f.client,
        owner: configuration.owner,
        actor: `human:${configuration.owner}`,
    };
    await f.client`INSERT INTO mira_runtime_status(id,worker_id,version,ready,heartbeat_at,integrations) VALUES(1,${crypto.randomUUID()},'synthetic',true,now(),${JSON.stringify([{ owner: configuration.owner, key: "daytona", bindingHash: daytonaBindingHash(configuration), sendConfigured: true }])}::text::jsonb)`;
    await publishDaytonaBinding(f.client, configuration);
    const operations = {
        ...f,
        daytonaBinding: configuration,
        miraFilesDirectory: directory,
    };
    const api = appRouter.createCaller({
        operations,
        principal: { kind: "human", id: configuration.owner, capabilities },
    }).mira;
    await api.controls.setEnabled({
        key: "integration:daytona",
        enabled: true,
        version: 1,
        reason: null,
        until: null,
    });
    const save = (content = defaultContent) =>
        api.daytona.save({
            id: crypto.randomUUID(),
            version: 0,
            conversationId: null,
            taskId: null,
            content,
        });
    const approve = (job: MiraDaytonaJob) =>
        api.daytona.approve({
            id: job.id,
            version: job.version,
            contentHash: job.contentHash,
            reviewedContent: job.content,
        });
    const read = (id: string) => api.daytona.read({ id });
    const pause = async () => {
        const controls = await api.controls.list();
        const control = controls.find((row) => row.key === "integration:daytona")!;
        await api.controls.setEnabled({
            key: control.key,
            version: control.version,
            enabled: false,
            reason: "Operator pause",
            until: null,
        });
    };
    return {
        ...f,
        context,
        directory,
        api,
        save,
        approve,
        read,
        pause,
        operations,
        close: async () => {
            await f.close();
            await rm(directory, { recursive: true, force: true });
        },
    };
}
function provider(
    jobId: string,
    options: {
        unknown?: string;
        fail?: string;
        exitCode?: number;
        logs?: string;
        missingOutput?: boolean;
        output?: string;
        beforeDownload?: () => Promise<void>;
        beforeCreate?: () => Promise<void>;
    } = {}
) {
    let created = false,
        opened = false,
        destroyed = false,
        command: string | null = null,
        completed = false;
    const calls: { url: URL; init: RequestInit }[] = [];
    const sandbox = () => ({
        id: sandboxId,
        name: daytonaSandboxName(configuration, jobId),
        organizationId: configuration.organizationId,
        labels: {
            "homelab.owner": daytonaBindingHash(configuration),
            "homelab.run": jobId,
            "homelab.service": "mira",
        },
        state: destroyed ? "destroyed" : "started",
        env: {},
        public: false,
        networkBlockAll: false,
        kvm: false,
        cpu: 2,
        memory: 4,
        disk: 10,
        gpu: 0,
        target: "eu",
        snapshot: configuration.snapshotId,
        autoDeleteInterval: 0,
        autoStopInterval: 5,
        autoPauseInterval: 0,
        createdAt: new Date(Date.now() - 1000).toISOString(),
        autoDestroyAt: new Date(Date.now() + 899_000).toISOString(),
    });
    const request = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (typeof input !== "string" || !init)
                throw new Error("Explicit request required");
            const url = new URL(input);
            calls.push({ url, init });
            const p = url.pathname;
            if (options.fail && p.endsWith(options.fail))
                return new Response("private diagnostic", { status: 503 });
            if (p === "/api/api-keys/current")
                return Response.json({
                    organizationId: configuration.organizationId,
                    userId: "owner",
                    permissions: ["write:sandboxes", "delete:sandboxes"],
                    expiresAt: null,
                });
            if (p.endsWith("/users"))
                return Response.json([
                    {
                        organizationId: configuration.organizationId,
                        userId: "owner",
                        role: "owner",
                    },
                ]);
            if (p.includes("/organizations/"))
                return Response.json({
                    id: configuration.organizationId,
                    suspended: false,
                });
            if (p.includes("/snapshots/")) {
                await options.beforeCreate?.();
                return Response.json({
                    id: configuration.snapshotId,
                    organizationId: configuration.organizationId,
                    general: false,
                    name: "qualified-synthetic",
                    state: "active",
                    cpu: 2,
                    mem: 4,
                    disk: 10,
                    gpu: 0,
                    sandboxClass: "container",
                });
            }
            if (p === "/api/sandbox" && init.method === "POST") {
                created = true;
                if (options.unknown === "create") throw new Error("lost acknowledgement");
                return Response.json(sandbox());
            }
            if (p.startsWith("/api/sandbox/")) {
                if (!created) return new Response(null, { status: 404 });
                if (init.method === "DELETE") {
                    destroyed = true;
                    if (options.unknown === "delete")
                        throw new Error("lost deletion ack");
                }
                return Response.json(sandbox());
            }
            if (p.endsWith("/process/session") && init.method === "POST") {
                opened = true;
                if (options.unknown === "session") throw new Error("lost session ack");
                return new Response(null, { status: 204 });
            }
            if (p.endsWith("/upload-v2")) {
                if (options.unknown === "upload") throw new Error("lost upload ack");
                return Response.json({ path: url.searchParams.get("path") });
            }
            if (p.endsWith("/exec")) {
                if (typeof init.body !== "string")
                    throw new Error("Expected JSON command body");
                command = (JSON.parse(init.body) as { command: string }).command;
                if (options.unknown === "command") throw new Error("lost command ack");
                return Response.json({ cmdId: "command-1" });
            }
            if (p.endsWith("/logs"))
                return Response.json({
                    stdout: options.logs ?? "1.4.4\n",
                    stderr: "",
                    output: "",
                });
            if (p.endsWith("/download")) {
                await options.beforeDownload?.();
                return options.missingOutput
                    ? new Response(null, { status: 404 })
                    : new Response(options.output ?? '{"result":true}');
            }
            if (p.endsWith(`/session/mira-${jobId}`))
                return opened
                    ? Response.json({
                          sessionId: `mira-${jobId}`,
                          commands: command
                              ? [
                                    {
                                        id: "command-1",
                                        command,
                                        exitCode: completed
                                            ? (options.exitCode ?? 0)
                                            : null,
                                    },
                                ]
                              : [],
                      })
                    : new Response(null, { status: 404 });
            throw new Error(`Unexpected synthetic route ${p}`);
        },
        { preconnect: fetch.preconnect }
    );
    return {
        request,
        calls,
        complete: () => {
            completed = true;
        },
        hide: () => {
            created = false;
        },
        writes: () => calls.filter((call) => call.init.method !== "GET"),
    };
}
async function advance(
    f: Awaited<ReturnType<typeof fixture>>,
    p: ReturnType<typeof provider>,
    count = 1
) {
    for (let i = 0; i < count; i++)
        await dispatchMiraDaytona(
            f.client,
            configuration,
            signal,
            f.directory,
            p.request
        );
}

test("Daytona uses exact human review and persists no credential in the original binding", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        const p = provider(draft.id);
        expect(
            await dispatchMiraDaytona(
                f.client,
                configuration,
                signal,
                f.directory,
                p.request
            )
        ).toBe(false);
        expect(p.calls).toHaveLength(0);
        const input = {
            id: draft.id,
            version: draft.version,
            contentHash: draft.contentHash,
            reviewedContent: draft.content,
        };
        await rejects(
            approveMiraDaytona(
                { ...f.context, actor: "mira:synthetic" },
                input,
                configuration
            ),
            /operator/
        );
        await rejects(
            f.api.daytona.approve({
                ...input,
                reviewedContent: { ...draft.content, command: "different" },
            }),
            /changed/
        );
        await rejects(f.api.daytona.approve({ ...input, version: 99 }), /changed/);
        await f.approve(draft);
        const [stored] = await f.client<
            { binding: unknown }[]
        >`SELECT binding FROM mira_daytona_jobs WHERE id=${draft.id}`;
        expect(JSON.stringify(stored)).not.toContain(configuration.apiKey);
        expect(JSON.stringify(stored)).not.toContain("apiKey");
        const foreign = appRouter.createCaller({
            operations: f.operations,
            principal: { kind: "human", id: "other", capabilities },
        }).mira;
        await rejects(foreign.daytona.read({ id: draft.id }), /not found/);
        expect(await foreign.daytona.list({})).toMatchObject({ rows: [] });
        await rejects(foreign.daytona.cancel({ id: draft.id, version: 2 }), /changed/);
    } finally {
        await f.close();
    }
});
test("Daytona completes transfers, stores bounded logs and confirms cleanup separately", async () => {
    const f = await fixture();
    try {
        const attachment = await saveMiraFile(f.context, f.directory, {
            id: crypto.randomUUID(),
            name: "input.txt",
            bytes: new TextEncoder().encode("selected data"),
        });
        const input = await f.api.daytona.input({ id: attachment.id });
        const job = await f.save({
            ...defaultContent,
            inputs: [input],
            outputs: ["result.json"],
        });
        await f.approve(job);
        const p = provider(job.id);
        await Promise.all([advance(f, p), advance(f, p), advance(f, p)]);
        expect(
            p.calls.filter(
                (call) =>
                    call.url.pathname === "/api/sandbox" && call.init.method === "POST"
            )
        ).toHaveLength(1);
        await rejects(deleteMiraFile(f.context, f.directory, input.id), /cloud job/);
        await advance(f, p, 5);
        expect(await f.read(job.id)).toMatchObject({ phase: "executing" });
        await advance(f, p);
        expect(await f.read(job.id)).toMatchObject({ stdout: "1.4.4\n" });
        p.complete();
        await advance(f, p, 3);
        let current = await f.read(job.id);
        expect(current.cleanup).toBe("pending");
        expect(current.exitCode).toBe(0);
        expect(current.files).toHaveLength(1);
        const result = await readMiraFile(f.context, f.directory, current.files[0]!.id);
        expect(new TextDecoder().decode(result.bytes)).toBe('{"result":true}');
        await advance(f, p);
        current = await f.read(job.id);
        expect(current).toMatchObject({
            state: "completed",
            cleanup: "confirmed",
            phase: "closed",
        });
        await deleteMiraFile(f.context, f.directory, input.id);
        expect(
            await dispatchMiraDaytona(
                f.client,
                configuration,
                signal,
                f.directory,
                p.request
            )
        ).toBe(false);
    } finally {
        await f.close();
    }
});
for (const phase of ["create", "session", "upload", "command"])
    test(`Daytona never replays an uncertain ${phase} write`, async () => {
        const f = await fixture();
        try {
            const file = await saveMiraFile(f.context, f.directory, {
                id: crypto.randomUUID(),
                name: "input.txt",
                bytes: new TextEncoder().encode("input"),
            });
            const job = await f.save({
                ...defaultContent,
                inputs:
                    phase === "upload"
                        ? [await f.api.daytona.input({ id: file.id })]
                        : [],
            });
            await f.approve(job);
            const p = provider(job.id, { unknown: phase });
            await advance(f, p, 9);
            expect(await f.read(job.id)).toMatchObject({
                state: "needs_attention",
                cleanup: "confirmed",
            });
            const writes = p.writes();
            expect(
                writes.filter((call) => call.url.pathname === "/api/sandbox")
            ).toHaveLength(1);
            expect(
                writes.filter((call) => call.url.pathname.endsWith("/exec")).length
            ).toBeLessThanOrEqual(1);
            expect(
                writes.filter((call) => call.url.pathname.endsWith("/upload-v2")).length
            ).toBeLessThanOrEqual(1);
            expect(
                writes.filter((call) => call.url.pathname.endsWith("/process/session"))
                    .length
            ).toBeLessThanOrEqual(1);
        } finally {
            await f.close();
        }
    });
test("Daytona keeps capacity reserved when an uncertain create remains invisible", async () => {
    const f = await fixture();
    try {
        const job = await f.save();
        await f.approve(job);
        const p = provider(job.id, { unknown: "create" });
        await advance(f, p);
        p.hide();
        await advance(f, p);
        expect(await f.read(job.id)).toMatchObject({
            cleanup: "pending",
            state: "needs_attention",
        });
        const second = await f.save();
        await f.approve(second);
        await advance(f, p);
        expect(await f.read(second.id)).toMatchObject({ state: "queued" });
        expect(
            p.calls.filter(
                (call) =>
                    call.url.pathname === "/api/sandbox" && call.init.method === "POST"
            )
        ).toHaveLength(1);
    } finally {
        await f.close();
    }
});
for (const phaseCount of [0, 1, 2, 3, 4, 5])
    test(`Daytona cancellation after ${phaseCount} phases does not free capacity before cleanup`, async () => {
        const f = await fixture();
        try {
            const job = await f.save();
            await f.approve(job);
            const p = provider(job.id);
            await advance(f, p, phaseCount);
            const current = await f.read(job.id);
            await f.api.daytona.cancel({ id: job.id, version: current.version });
            const writes = p.writes().length;
            await advance(f, p, 4);
            expect(await f.read(job.id)).toMatchObject({
                state: "cancelled",
                phase: "closed",
            });
            expect(
                p
                    .writes()
                    .slice(writes)
                    .every((call) => call.init.method === "DELETE")
            ).toBe(true);
        } finally {
            await f.close();
        }
    });
test("Daytona pause during preflight prevents creation and does not strand admission", async () => {
    const f = await fixture();
    try {
        const job = await f.save();
        await f.approve(job);
        const p = provider(job.id, { beforeCreate: () => f.pause() });
        await advance(f, p);
        expect(p.writes()).toHaveLength(0);
        expect(await f.read(job.id)).toMatchObject({ cleanup: "confirmed" });
    } finally {
        await f.close();
    }
});
test("Daytona cleanup continues while paused and after a snapshot change", async () => {
    const f = await fixture();
    try {
        const job = await f.save();
        await f.approve(job);
        const p = provider(job.id);
        await advance(f, p, 4);
        await f.pause();
        await advance(f, p);
        await dispatchMiraDaytona(
            f.client,
            {
                ...configuration,
                snapshotId: crypto.randomUUID(),
                executionQualified: false,
            },
            signal,
            f.directory,
            p.request
        );
        expect(await f.read(job.id)).toMatchObject({
            state: "cancelled",
            cleanup: "confirmed",
        });
    } finally {
        await f.close();
    }
});
test("Daytona recovers abandoned write phases without rerunning the command", async () => {
    const f = await fixture();
    try {
        const job = await f.save();
        await f.approve(job);
        const p = provider(job.id);
        await advance(f, p);
        await f.client`UPDATE mira_daytona_jobs SET phase='submitting',lease_token=${crypto.randomUUID()},lease_expires_at=now()-interval '1 second' WHERE id=${job.id}`;
        await advance(f, p, 2);
        expect(await f.read(job.id)).toMatchObject({
            cleanup: "confirmed",
            state: "needs_attention",
        });
        expect(p.calls.some((call) => call.url.pathname.endsWith("/exec"))).toBe(false);
    } finally {
        await f.close();
    }
});
test("Daytona revokes stale approval and caps rolling admissions", async () => {
    const f = await fixture();
    try {
        const expired = await f.save();
        await f.approve(expired);
        await f.client`UPDATE mira_daytona_jobs SET approved_at=now()-interval '16 minutes' WHERE id=${expired.id}`;
        const p = provider(expired.id);
        await advance(f, p);
        expect(await f.read(expired.id)).toMatchObject({ state: "draft" });
        expect(p.calls).toHaveLength(0);
        for (let index = 0; index < 4; index++) {
            const old = await f.save();
            await f.client`UPDATE mira_daytona_jobs SET state='failed',started_at=now()-interval '1 hour' WHERE id=${old.id}`;
        }
        const waiting = await f.save();
        await f.approve(waiting);
        await advance(f, p);
        expect(await f.read(waiting.id)).toMatchObject({ state: "queued" });
        expect(p.calls).toHaveLength(0);
    } finally {
        await f.close();
    }
});
test("Daytona lost deletion acknowledgement is reconciled before reporting cleanup", async () => {
    const f = await fixture();
    try {
        const job = await f.save();
        await f.approve(job);
        const p = provider(job.id, { unknown: "delete" });
        await advance(f, p);
        await f.pause();
        await advance(f, p, 2);
        expect(await f.read(job.id)).toMatchObject({ cleanup: "pending" });
        await f.client`UPDATE mira_daytona_jobs SET retry_at=NULL WHERE id=${job.id}`;
        await advance(f, p);
        expect(await f.read(job.id)).toMatchObject({ cleanup: "confirmed" });
    } finally {
        await f.close();
    }
});
for (const options of [
    { exitCode: 7 },
    { logs: "x".repeat(140_000) },
    { missingOutput: true },
])
    test("Daytona reports nonzero exits, missing results and incomplete logs honestly", async () => {
        const f = await fixture();
        try {
            const job = await f.save({
                ...defaultContent,
                outputs: options.missingOutput ? ["missing.txt"] : [],
            });
            await f.approve(job);
            const p = provider(job.id, options);
            p.complete();
            await advance(f, p, 10);
            const current = await f.read(job.id);
            expect(current.cleanup).toBe("confirmed");
            if (options.exitCode) expect(current.state).toBe("failed");
            if (options.missingOutput) expect(current.state).toBe("needs_attention");
            if (options.logs) expect(current.message).toContain("incomplete");
        } finally {
            await f.close();
        }
    });
test("Daytona qualification is explicit and changes with the snapshot binding", () => {
    const environment = {
        HOMELAB_MIRA_DAYTONA_OWNER: configuration.owner,
        HOMELAB_MIRA_DAYTONA_ORGANIZATION_ID: configuration.organizationId,
        HOMELAB_MIRA_DAYTONA_SNAPSHOT_ID: configuration.snapshotId,
        HOMELAB_MIRA_DAYTONA_TARGET: configuration.target,
        HOMELAB_MIRA_DAYTONA_TRUST_BOUNDARY: configuration.trustBoundary,
        HOMELAB_MIRA_DAYTONA_NETWORK_ACCESS: configuration.networkAccess,
        HOMELAB_MIRA_DAYTONA_API_KEY: configuration.apiKey,
    };
    expect(daytonaExecutionConfiguration({})).toBeUndefined();
    expect(daytonaExecutionConfiguration(environment)?.executionQualified).toBe(false);
    expect(
        daytonaExecutionConfiguration({
            ...environment,
            HOMELAB_MIRA_DAYTONA_QUALIFIED_BINDING_HASH:
                daytonaBindingHash(configuration),
        })?.executionQualified
    ).toBe(true);
    expect(
        daytonaExecutionConfiguration({
            ...environment,
            HOMELAB_MIRA_DAYTONA_SNAPSHOT_ID: crypto.randomUUID(),
            HOMELAB_MIRA_DAYTONA_QUALIFIED_BINDING_HASH:
                daytonaBindingHash(configuration),
        })?.executionQualified
    ).toBe(false);
});
test("Daytona validates input ownership and stale file digests", async () => {
    const f = await fixture();
    try {
        const id = crypto.randomUUID();
        await rejects(f.api.daytona.input({ id }), /available file/);
        await rejects(
            f.save({
                ...defaultContent,
                inputs: [{ id, name: "input.txt", sha256: "0".repeat(64) }],
            }),
            /selected input/
        );
        await rejects(
            saveMiraDaytona(
                { ...f.context, owner: "other" },
                {
                    id,
                    version: 0,
                    conversationId: null,
                    taskId: null,
                    content: defaultContent,
                },
                configuration
            ),
            /not configured/
        );
    } finally {
        await f.close();
    }
});

test("Daytona model proposals bind to the conversation and cannot execute or approve", async () => {
    const f = await fixture();
    try {
        const chat = await f.api.conversations.create({ title: "Cloud proposal" });
        const attached = await saveMiraFile(f.context, f.directory, {
            id: crypto.randomUUID(),
            name: "selected.txt",
            bytes: new TextEncoder().encode("selected"),
        });
        const unrelated = await saveMiraFile(f.context, f.directory, {
            id: crypto.randomUUID(),
            name: "private.txt",
            bytes: new TextEncoder().encode("not selected"),
        });
        await f.api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Prepare a cloud job",
            attachmentIds: [attached.id],
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
            configuration
        );
        expect(
            tools.some((tool) =>
                /daytona.*(approve|execute|create_sandbox)/.test(tool.name)
            )
        ).toBe(false);
        const draft = tools.find((tool) => tool.name === "mira_daytona_draft")!;
        const call = {
            callId: "cloud-draft",
            threadId: "synthetic",
            turnId: "synthetic",
        };
        const input = {
            id: crypto.randomUUID(),
            version: 0,
            title: "Cloud draft",
            command: "bun --version",
            inputs: [{ id: attached.id, name: "selected.txt" }],
            outputs: [],
        };
        expect(JSON.parse(await draft.execute(input, signal, call))).toMatchObject({
            ok: true,
        });
        expect(JSON.parse(await draft.execute(input, signal, call))).toMatchObject({
            ok: false,
        });
        const page = await f.api.daytona.list({ conversationId: chat.id });
        expect(page.rows).toHaveLength(1);
        expect(page.rows[0]).toMatchObject({ state: "draft", conversationId: chat.id });
        expect(
            JSON.parse(
                await draft.execute(
                    {
                        ...input,
                        id: crypto.randomUUID(),
                        inputs: [{ id: unrelated.id, name: "private.txt" }],
                    },
                    signal,
                    { ...call, callId: "unselected" }
                )
            )
        ).toMatchObject({ ok: false });
        const list = tools.find((tool) => tool.name === "mira_daytona_jobs")!;
        expect(
            JSON.parse(await list.execute({}, signal, { ...call, callId: "list" }))
        ).toMatchObject({
            ok: true,
            result: { rows: [{ id: input.id, state: "draft" }] },
        });
        const result = tools.find((tool) => tool.name === "mira_daytona_result")!;
        expect(
            JSON.parse(
                await result.execute({ id: input.id }, signal, {
                    ...call,
                    callId: "result",
                })
            )
        ).toMatchObject({ ok: true, result: { trust: "untrusted_cloud_output" } });
        const outside = await f.save();
        expect(
            JSON.parse(
                await result.execute({ id: outside.id }, signal, {
                    ...call,
                    callId: "foreign-chat",
                })
            )
        ).toMatchObject({ ok: false });
        await f.pause();
        expect(
            JSON.parse(
                await draft.execute({ ...input, id: crypto.randomUUID() }, signal, {
                    ...call,
                    callId: "paused",
                })
            )
        ).toMatchObject({ ok: false });
    } finally {
        await f.close();
    }
});

test("Daytona does not free an acknowledged creation on a premature 404", async () => {
    const f = await fixture();
    try {
        const job = await f.save();
        await f.approve(job);
        const p = provider(job.id);
        await advance(f, p);
        p.hide();
        await f.pause();
        await advance(f, p, 2);
        expect(await f.read(job.id)).toMatchObject({
            cleanup: "pending",
            state: "needs_attention",
        });
    } finally {
        await f.close();
    }
});
test("Daytona releases a recovered admission if configuration vanished before any create attempt", async () => {
    const f = await fixture();
    try {
        const job = await f.save();
        await f.approve(job);
        await f.client`UPDATE mira_daytona_jobs SET state='running',phase='admitted',cleanup='pending',started_at=now(),deadline=now()+interval '15 minutes' WHERE id=${job.id}`;
        const p = provider(job.id);
        await dispatchMiraDaytona(f.client, undefined, signal, f.directory, p.request);
        expect(await f.read(job.id)).toMatchObject({
            state: "cancelled",
            cleanup: "confirmed",
        });
        expect(p.calls).toHaveLength(0);
    } finally {
        await f.close();
    }
});
test("Daytona cannot confirm deletion when the second ownership inspection loses the resource", async () => {
    const f = await fixture();
    try {
        const job = await f.save();
        await f.approve(job);
        const p = provider(job.id);
        await advance(f, p);
        await f.pause();
        await advance(f, p);
        let observations = 0;
        const request = Object.assign(
            async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (
                    typeof input === "string" &&
                    new URL(input).pathname.startsWith("/api/sandbox/")
                ) {
                    observations++;
                    if (observations === 2) p.hide();
                }
                return p.request(input, init);
            },
            { preconnect: fetch.preconnect }
        );
        await dispatchMiraDaytona(f.client, configuration, signal, f.directory, request);
        expect(await f.read(job.id)).toMatchObject({ cleanup: "pending" });
        expect(p.writes().filter((call) => call.init.method === "DELETE")).toHaveLength(
            0
        );
    } finally {
        await f.close();
    }
});

for (const qualification of [false, undefined])
    test(`Daytona timed resume preserves its pause when qualification is ${String(qualification)}`, async () => {
        const f = await fixture();
        try {
            const controls = await f.api.controls.list();
            const control = controls.find((row) => row.key === "integration:daytona")!;
            await f.api.controls.setEnabled({
                key: control.key,
                version: control.version,
                enabled: false,
                reason: "Wait for qualified snapshot",
                until: new Date(Date.now() + 60_000).toISOString(),
            });
            await f.client`UPDATE mira_switches SET until=now()-interval '1 second' WHERE owner=${configuration.owner} AND key='integration:daytona'`;
            const entry = {
                owner: configuration.owner,
                key: "daytona",
                bindingHash: daytonaBindingHash(configuration),
                sendConfigured: qualification,
            };
            await f.client`UPDATE mira_runtime_status SET integrations=${JSON.stringify([entry])}::text::jsonb,heartbeat_at=now() WHERE id=1`;
            await f.client.begin((query) =>
                resumeMiraControls(query, new Date(), configuration.owner)
            );
            const pausedControls = await f.api.controls.list();
            const paused = pausedControls.find((row) => row.key === control.key)!;
            expect(paused).toMatchObject({
                enabled: false,
                reason: "Wait for qualified snapshot",
                version: control.version + 1,
            });
            expect(paused.until).not.toBeNull();
            await f.client`UPDATE mira_runtime_status SET integrations=${JSON.stringify([{ ...entry, sendConfigured: true }])}::text::jsonb,heartbeat_at=now() WHERE id=1`;
            await f.client.begin((query) =>
                resumeMiraControls(query, new Date(), configuration.owner)
            );
            const resumedControls = await f.api.controls.list();
            expect(resumedControls.find((row) => row.key === control.key)).toMatchObject({
                enabled: true,
                reason: null,
                until: null,
                version: control.version + 2,
            });
        } finally {
            await f.close();
        }
    });

test("Daytona model listing paginates older jobs within the current conversation", async () => {
    const f = await fixture();
    try {
        const chat = await f.api.conversations.create({ title: "Cloud history" });
        const expected = [];
        for (let index = 0; index < 21; index++) {
            const id = crypto.randomUUID();
            await f.api.daytona.save({
                id,
                version: 0,
                conversationId: chat.id,
                taskId: null,
                content: { ...defaultContent, title: `Job ${index}` },
            });
            expected.push(id);
        }
        await f.save();
        await f.api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Find older jobs",
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
            configuration
        );
        const list = tools.find((tool) => tool.name === "mira_daytona_jobs")!;
        const call = { threadId: "synthetic", turnId: "synthetic" };
        type Page = {
            ok: boolean;
            result: { rows: { id: string }[]; nextCursor: string | null };
        };
        const first = JSON.parse(
            await list.execute({}, signal, { ...call, callId: "page-one" })
        ) as Page;
        expect(first.ok).toBe(true);
        expect(first.result.rows).toHaveLength(20);
        expect(typeof first.result.nextCursor).toBe("string");
        const second = JSON.parse(
            await list.execute({ before: first.result.nextCursor }, signal, {
                ...call,
                callId: "page-two",
            })
        ) as Page;
        expect(second.ok).toBe(true);
        expect(second.result.rows).toHaveLength(1);
        expect(second.result.nextCursor).toBeNull();
        const ids = [...first.result.rows, ...second.result.rows].map(
            (job: { id: string }) => job.id
        );
        expect(new Set(ids).size).toBe(21);
        expect(ids.toSorted()).toEqual(expected.toSorted());
        expect(
            JSON.parse(
                await list.execute({ before: "invalid-cursor" }, signal, {
                    ...call,
                    callId: "invalid-page",
                })
            )
        ).toMatchObject({ ok: false });
    } finally {
        await f.close();
    }
});

test("Daytona closes cancelled drafts without dispatching a sandbox", async () => {
    const f = await fixture();
    try {
        const draft = await f.save();
        const cancelled = await f.api.daytona.cancel({
            id: draft.id,
            version: draft.version,
        });
        expect(cancelled).toMatchObject({
            state: "cancelled",
            phase: "closed",
            cleanup: "not_needed",
        });
        const p = provider(draft.id);
        expect(
            await dispatchMiraDaytona(
                f.client,
                configuration,
                signal,
                f.directory,
                p.request
            )
        ).toBe(false);
        expect(p.writes()).toHaveLength(0);
    } finally {
        await f.close();
    }
});

test("Daytona cancellation replaces a pending failure outcome but cannot cancel a finalized result", async () => {
    const f = await fixture();
    try {
        const job = await f.save({ ...defaultContent, outputs: ["missing.txt"] });
        await f.approve(job);
        const p = provider(job.id, { missingOutput: true });
        p.complete();
        await advance(f, p, 6);
        const pending = await f.read(job.id);
        expect(pending).toMatchObject({ phase: "cleaning", cleanup: "pending" });
        await f.api.daytona.cancel({ id: job.id, version: pending.version });
        await advance(f, p, 3);
        expect(await f.read(job.id)).toMatchObject({
            state: "cancelled",
            cleanup: "confirmed",
            exitCode: 0,
        });
        const failed = await f.save({ ...defaultContent, outputs: ["missing.txt"] });
        await f.approve(failed);
        const other = provider(failed.id, { missingOutput: true });
        other.complete();
        await advance(f, other, 10);
        const terminal = await f.read(failed.id);
        expect(terminal).toMatchObject({
            state: "needs_attention",
            cleanup: "confirmed",
        });
        await rejects(
            f.api.daytona.cancel({ id: failed.id, version: terminal.version }),
            /changed/
        );
        expect(await f.read(failed.id)).toMatchObject({
            state: "needs_attention",
            cancelRequested: false,
        });
    } finally {
        await f.close();
    }
});

test("Daytona cancellation survives a concurrent artifact failure", async () => {
    const f = await fixture();
    try {
        const job = await f.save({ ...defaultContent, outputs: ["missing.txt"] });
        await f.approve(job);
        const p = provider(job.id, {
            missingOutput: true,
            beforeDownload: async () => {
                const current = await f.read(job.id);
                await f.api.daytona.cancel({ id: job.id, version: current.version });
            },
        });
        p.complete();
        await advance(f, p, 10);
        expect(await f.read(job.id)).toMatchObject({
            state: "cancelled",
            cleanup: "confirmed",
            cancelRequested: true,
        });
    } finally {
        await f.close();
    }
});

test("Daytona clears a recovered log warning without erasing unrelated notices", async () => {
    const f = await fixture();
    try {
        const job = await f.save();
        await f.approve(job);
        const options: { fail?: string; logs: string } = {
            fail: "/logs",
            logs: "Recovered complete logs",
        };
        const p = provider(job.id, options);
        await advance(f, p, 5);
        const incomplete = await f.read(job.id);
        expect(incomplete.message).toContain("incomplete");
        delete options.fail;
        await advance(f, p);
        expect(await f.read(job.id)).toMatchObject({
            stdout: options.logs,
            message: null,
        });
        await f.client`UPDATE mira_daytona_jobs SET message='Separate retained notice.' WHERE id=${job.id}`;
        p.complete();
        await advance(f, p, 5);
        expect(await f.read(job.id)).toMatchObject({
            state: "completed",
            cleanup: "confirmed",
            message: "Separate retained notice.",
        });
    } finally {
        await f.close();
    }
});

test("Mira reads bounded cloud artifacts only from its owned conversation", async () => {
    const f = await fixture();
    try {
        const chat = await f.api.conversations.create({ title: "Cloud artifacts" });
        const otherChat = await f.api.conversations.create({
            title: "Other conversation",
        });
        const executeOutput = async (conversationId: string, output: string) => {
            const job = await f.api.daytona.save({
                id: crypto.randomUUID(),
                version: 0,
                conversationId,
                taskId: null,
                content: { ...defaultContent, outputs: ["result.txt"] },
            });
            await f.approve(job);
            const p = provider(job.id, { output });
            p.complete();
            await advance(f, p, 10);
            const result = await f.read(job.id);
            expect(result).toMatchObject({ state: "completed", cleanup: "confirmed" });
            expect(result.files).toHaveLength(1);
            return result;
        };
        const content = "Untrusted artifact text.\n" + "x".repeat(60_000);
        const job = await executeOutput(chat.id, content);
        const other = await executeOutput(
            otherChat.id,
            "Not authorized for this conversation"
        );
        const unlinked = await saveMiraFile(f.context, f.directory, {
            id: crypto.randomUUID(),
            name: "unlinked.txt",
            bytes: new TextEncoder().encode("Unlinked private content"),
        });
        await f.api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Read the recorded result",
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
            configuration
        );
        const reader = tools.find((tool) => tool.name === "mira_attachment_read")!;
        const read = async (id: string, offset = 0) =>
            JSON.parse(
                await reader.execute({ id, offset }, signal, {
                    callId: crypto.randomUUID(),
                    threadId: "synthetic",
                    turnId: "synthetic",
                })
            ) as { ok: boolean; result: { text: string; nextOffset: number | null } };
        await f.pause();
        const first = await read(job.files[0]!.id);
        expect(first.ok).toBe(true);
        expect(first.result.text).toBe(content.slice(0, 48_000));
        expect(first.result.nextOffset).toBe(48_000);
        const second = await read(job.files[0]!.id, first.result.nextOffset!);
        expect(second.ok).toBe(true);
        expect(second.result.text).toBe(content.slice(48_000));
        expect(second.result.nextOffset).toBeNull();
        expect(await read(other.files[0]!.id)).toMatchObject({ ok: false });
        expect(await read(unlinked.id)).toMatchObject({ ok: false });
        await f.client`UPDATE mira_daytona_jobs SET owner='different-owner' WHERE id=${job.id}`;
        expect(await read(job.files[0]!.id)).toMatchObject({ ok: false });
        await f.client`UPDATE mira_daytona_jobs SET owner=${configuration.owner} WHERE id=${job.id}`;
        await deleteMiraFile(f.context, f.directory, job.files[0]!.id);
        expect(await read(job.files[0]!.id)).toMatchObject({ ok: false });
    } finally {
        await f.close();
    }
});
