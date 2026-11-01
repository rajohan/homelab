import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { captureCodeSource } from "@homelab/mira/data/codeSource";
import {
    approveMiraDaytona,
    cancelMiraDaytona,
    readMiraDaytona,
    saveMiraDaytona,
} from "@homelab/mira/data/daytona";
import { readMiraDaytonaRecovery } from "@homelab/mira/data/daytonaRecovery";
import { readMiraFile, saveMiraFile } from "@homelab/mira/data/files";
import { dispatchMiraDaytona } from "@homelab/mira/integrations/daytona/jobs";
import {
    localCodeBindingHash,
    publishLocalCodeBinding,
    type LocalCodeBinding,
} from "@homelab/mira/sandbox/localBinding";
import type {
    LocalCodeJournal,
    executeLocalCodeCheck,
    cleanupLocalCodeContainer,
} from "@homelab/mira/sandbox/localContainer";
import { dispatchMiraLocalCode } from "@homelab/mira/sandbox/localJobs";
import {
    localCodeRequest,
    type LocalCheckResult,
} from "@homelab/mira/sandbox/localProtocol";
import {
    daytonaCheckContent,
    daytonaEditContent,
    daytonaSourceContent,
} from "@homelab/mira/sandbox/profile";
import type { TransactionSQL } from "bun";

import { operationFixture } from "../testing/operations";

const binding: LocalCodeBinding = {
    kind: "main",
    owner: "operator",
    hostId: "11111111-1111-4111-8111-111111111111",
    imageId: `sha256:${"a".repeat(64)}`,
    egress: {
        networkId: "b".repeat(64),
        proxyId: "c".repeat(64),
        proxyImageId: `sha256:${"d".repeat(64)}`,
    },
};
const containerId = "e".repeat(64);
const commit = "f".repeat(40);
const signal = new AbortController().signal;
const result: LocalCheckResult = {
    exitCode: 0,
    files: [
        { name: "check-result.json", text: '{"exitCode":0}' },
        { name: "check-log.txt", text: "Fixture checks passed." },
        { name: "changes.txt", text: "Fixture diff" },
    ],
};
const execute: typeof executeLocalCodeCheck = async (
    _config,
    _input,
    journal,
    stopping
) => {
    await journal.creating(stopping);
    await journal.created(containerId, stopping);
    await journal.starting(stopping);
    await journal.cleaning(signal);
    await journal.cleaned(signal);
    return result;
};
const cleanup: typeof cleanupLocalCodeContainer = async (_config, record, journal) => {
    await journal.cleaning(signal);
    if (!record.settled && !record.containerId) throw new Error("Uncertain creation.");
    if (record.containerId) await journal.discovered(record.containerId, signal);
    await journal.cleaned(signal);
};

async function fixture() {
    const f = await operationFixture();
    const filesDirectory = await mkdtemp(path.join(tmpdir(), "mira-local-jobs-"));
    const context = {
        client: f.client,
        owner: binding.owner,
        actor: `human:${binding.owner}`,
    };
    await publishLocalCodeBinding(f.client, binding);
    await f.client`INSERT INTO mira_switches(owner,key,enabled,binding_hash) VALUES(${binding.owner},'code:main',true,${localCodeBindingHash(binding)})`;
    const options = {
        client: f.client,
        binding,
        socketPath: "/synthetic/socket",
        filesDirectory,
        signal,
    };
    const save = async (
        id = Bun.randomUUIDv7(),
        content = daytonaCheckContent({ id, commit, patchSha256: null })
    ) =>
        saveMiraDaytona(
            context,
            { id, version: 0, content, conversationId: null, taskId: null },
            binding
        );
    const queue = async (
        id = Bun.randomUUIDv7(),
        content = daytonaCheckContent({ id, commit, patchSha256: null })
    ) => {
        const job = await save(id, content);
        return approveMiraDaytona(
            context,
            {
                id: job.id,
                version: job.version,
                contentHash: job.contentHash,
                reviewedContent: job.content,
                executionTarget: "main",
            },
            binding
        );
    };
    const read = (id: string) => readMiraDaytona(f.client, binding.owner, id);
    return {
        ...f,
        context,
        options,
        save,
        queue,
        read,
        close: async () => {
            await f.close();
            await rm(filesDirectory, { recursive: true, force: true });
        },
    };
}

test("Main accepts canonical source/check/edit requests and refuses arbitrary commands or changed transfers", async () => {
    const f = await fixture();
    try {
        const id = Bun.randomUUIDv7();
        for (const paths of [[], ["apps/a.ts", "packages/a(b).ts"]]) {
            const content = daytonaSourceContent({ id, commit, paths });
            expect(localCodeRequest(id, content)).toEqual({ id, commit, paths });
        }
        const content = daytonaCheckContent({ id, commit, patchSha256: null });
        for (const changed of [
            { ...content, command: "touch /host/file" },
            { ...content, command: content.command + " ; echo unexpected" },
            { ...content, outputs: [] },
            { ...content, command: content.command.replace(id, crypto.randomUUID()) },
        ])
            await rejects(f.save(id, changed));
        await rejects(
            saveMiraDaytona(
                { ...f.context, owner: "other" },
                { id, version: 0, content, conversationId: null, taskId: null },
                binding
            ),
            /not configured/
        );
        const saved = await f.save(id);
        for (const executionTarget of [undefined, "daytona"] as const)
            await rejects(
                approveMiraDaytona(
                    f.context,
                    {
                        id,
                        version: saved.version,
                        contentHash: saved.contentHash,
                        reviewedContent: saved.content,
                        executionTarget,
                    },
                    binding
                ),
                /reviewed job changed/
            );
        await rejects(
            approveMiraDaytona(
                { ...f.context, actor: "mira:executor" },
                {
                    id,
                    version: saved.version,
                    contentHash: saved.contentHash,
                    reviewedContent: content,
                },
                binding
            ),
            /operator/
        );
        await rejects(readMiraDaytona(f.client, "other", id), /not found/);
        await rejects(readMiraDaytonaRecovery(f.context, id), /not found/);
    } finally {
        await f.close();
    }
});

test.each(["paused", "deadline", "shutdown"])(
    "active Main execution stops after %s and still confirms cleanup",
    async (reason) => {
        const f = await fixture();
        const controller = new AbortController();
        try {
            const job = await f.queue();
            let stopped = false;
            await dispatchMiraLocalCode(
                { ...f.options, signal: controller.signal },
                {
                    execute: async (_config, _input, journal, stopping) => {
                        await journal.creating(stopping);
                        await journal.created(containerId, stopping);
                        await journal.starting(stopping);
                        if (reason === "paused")
                            await f.client`UPDATE mira_switches SET enabled=false,version=version+1 WHERE key='code:main'`;
                        if (reason === "deadline")
                            await f.client`UPDATE mira_daytona_jobs SET deadline=clock_timestamp()-interval '1 second' WHERE id=${job.id}`;
                        if (reason === "shutdown") controller.abort();
                        if (!stopping.aborted)
                            await new Promise<void>((resolve) =>
                                stopping.addEventListener("abort", () => resolve(), {
                                    once: true,
                                })
                            );
                        stopped = true;
                        throw new Error("Interrupted work");
                    },
                    cleanup,
                }
            );
            expect(stopped).toBe(true);
            const closed = await f.read(job.id);
            expect(closed).toMatchObject({
                state: "needs_attention",
                cleanup: "confirmed",
                phase: "closed",
                files: [],
            });
        } finally {
            controller.abort();
            await f.close();
        }
    },
    10_000
);

test.each(["failed", "invalid"])(
    "Main treats %s results without granting publication",
    async (condition) => {
        const f = await fixture();
        try {
            const job = await f.queue();
            await dispatchMiraLocalCode(f.options, {
                execute: async (...args) => {
                    await execute(...args);
                    return condition === "failed"
                        ? { ...result, exitCode: 1 }
                        : { ...result, files: [] };
                },
                cleanup,
            });
            const closed = await f.read(job.id);
            expect(closed).toMatchObject({
                state: condition === "failed" ? "failed" : "needs_attention",
                cleanup: "confirmed",
                phase: "closed",
                exitCode: condition === "failed" ? 1 : null,
            });
            await rejects(
                captureCodeSource(
                    f.client,
                    f.context,
                    { checkId: job.id, commit, title: "fix: change", body: "Change" },
                    null
                )
            );
        } finally {
            await f.close();
        }
    }
);

test("lost final commit acknowledgement preserves committed local results", async () => {
    const f = await fixture();
    try {
        const job = await f.queue();
        let lost = false;
        const interrupted = new Proxy(f.client, {
            get(target, property, receiver) {
                if (property !== "begin")
                    return Reflect.get(target, property, receiver) as unknown;
                return async (callback: (query: TransactionSQL) => Promise<unknown>) => {
                    const value = await target.begin(callback);
                    const stored = await f.read(job.id);
                    if (!lost && stored.state === "completed") {
                        lost = true;
                        throw new Error("Lost commit acknowledgement");
                    }
                    return value;
                };
            },
        });
        await dispatchMiraLocalCode(
            { ...f.options, client: interrupted },
            { execute, cleanup }
        );
        expect(lost).toBe(true);
        const completed = await f.read(job.id);
        expect(completed).toMatchObject({
            state: "completed",
            cleanup: "confirmed",
            phase: "closed",
            exitCode: 0,
            message: null,
        });
        expect(completed.files).toHaveLength(3);
    } finally {
        await f.close();
    }
});

test("local checks retain approved inputs and share result/publication provenance without a Daytona account", async () => {
    const f = await fixture();
    try {
        const id = Bun.randomUUIDv7();
        const bytes = Buffer.from(
            JSON.stringify({
                version: 1,
                commit,
                files: [
                    {
                        path: "apps/example.ts",
                        beforeSha256: null,
                        content: "export {};\n",
                    },
                ],
            })
        );
        const file = await saveMiraFile(f.context, f.options.filesDirectory, {
            id: Bun.randomUUIDv7(),
            name: "edits.json",
            bytes,
        });
        const selected = {
            id: file.id,
            sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        };
        const job = await f.queue(
            id,
            daytonaEditContent({ id, commit, editsSha256: selected.sha256 }, selected)
        );
        expect(await dispatchMiraDaytona(f.client, undefined, signal)).toBe(false);
        let received = "";
        expect(
            await dispatchMiraLocalCode(f.options, {
                execute: async (...args) => {
                    received = JSON.stringify(args[1]);
                    return execute(...args);
                },
                cleanup,
            })
        ).toBe(true);
        expect(received).toContain("editsSha256");
        expect(received).toContain("export {};");
        const completed = await f.read(job.id);
        expect(completed).toMatchObject({
            state: "completed",
            cleanup: "confirmed",
            exitCode: 0,
            phase: "closed",
        });
        expect(completed.files.map((entry) => entry.name)).toEqual(
            result.files.map((entry) => entry.name)
        );
        const log = await readMiraFile(
            f.context,
            f.options.filesDirectory,
            completed.files[1]!.id
        );
        expect(log.bytes.toString()).toBe("Fixture checks passed.");
        const source = await captureCodeSource(
            f.client,
            f.context,
            {
                checkId: id,
                commit,
                title: "fix: fixture change",
                body: "Verified change",
            },
            null
        );
        expect(source.edits).toEqual(selected);
        expect(
            await dispatchMiraLocalCode(f.options, {
                execute: () => Promise.reject(new Error("Must not replay")),
            })
        ).toBe(false);
    } finally {
        await f.close();
    }
});

test.each(["expired", "paused", "heartbeat", "input", "image"])(
    "Main refuses %s approval before execution",
    async (reason) => {
        const f = await fixture();
        try {
            const job = await f.queue();
            if (reason === "expired")
                await f.client`UPDATE mira_daytona_jobs SET approved_at=clock_timestamp()-interval '16 minutes' WHERE id=${job.id}`;
            if (reason === "paused")
                await f.client`UPDATE mira_switches SET enabled=false WHERE key='code:main'`;
            if (reason === "heartbeat")
                await f.client`UPDATE mira_integration_receivers SET heartbeat_at=clock_timestamp()-interval '46 seconds' WHERE key='code:main'`;
            if (reason === "input")
                await f.client`UPDATE mira_daytona_jobs SET content=content || '{"command":"unsafe"}'::jsonb WHERE id=${job.id}`;
            const options =
                reason === "image"
                    ? {
                          ...f.options,
                          binding: { ...binding, imageId: `sha256:${"0".repeat(64)}` },
                      }
                    : f.options;
            let calls = 0;
            expect(
                await dispatchMiraLocalCode(options, {
                    execute: async (...args) => {
                        calls++;
                        return execute(...args);
                    },
                })
            ).toBe(false);
            expect(calls).toBe(0);
            const draft = await f.read(job.id);
            expect(draft.state).toBe("draft");
        } finally {
            await f.close();
        }
    }
);

test("cancellation after input starts prevents accepting outputs and publication", async () => {
    const f = await fixture();
    try {
        const job = await f.queue();
        await dispatchMiraLocalCode(f.options, {
            execute: async (_config, _input, journal, stopping) => {
                await journal.creating(stopping);
                await journal.created(containerId, stopping);
                await journal.starting(stopping);
                const current = await f.read(job.id);
                await cancelMiraDaytona(f.context, {
                    id: job.id,
                    version: current.version,
                });
                await journal.cleaning(signal);
                await journal.cleaned(signal);
                return result;
            },
            cleanup,
        });
        const cancelled = await f.read(job.id);
        expect(cancelled).toMatchObject({
            state: "cancelled",
            cleanup: "confirmed",
            phase: "closed",
            files: [],
        });
    } finally {
        await f.close();
    }
});

test("interrupted local work recovers on its original host/image while paused and never re-executes", async () => {
    const f = await fixture();
    try {
        const job = await f.queue();
        await f.client`UPDATE mira_daytona_jobs SET state='running',phase='executing',cleanup='pending',local_container_id=${containerId},local_creation_settled=true,lease_token=${crypto.randomUUID()},lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${job.id}`;
        await f.client`UPDATE mira_switches SET enabled=false WHERE key='code:main'`;
        expect(
            await dispatchMiraLocalCode({
                ...f.options,
                binding: { ...binding, hostId: crypto.randomUUID() },
            })
        ).toBe(false);
        let image: unknown;
        let executions = 0;
        await dispatchMiraLocalCode(
            {
                ...f.options,
                binding: { ...binding, imageId: `sha256:${"0".repeat(64)}` },
            },
            {
                execute: async (...args) => {
                    executions++;
                    return execute(...args);
                },
                cleanup: async (...args) => {
                    image = args[0];
                    return cleanup(...args);
                },
            }
        );
        expect(executions).toBe(0);
        expect(image).toMatchObject({ imageId: binding.imageId });
        const recovered = await f.read(job.id);
        expect(recovered).toMatchObject({
            state: "needs_attention",
            cleanup: "confirmed",
            phase: "closed",
        });
    } finally {
        await f.close();
    }
});

test("uncertain creation reserves shared capacity and late callbacks cannot revive retired execution", async () => {
    const f = await fixture();
    try {
        const job = await f.queue();
        let retained: LocalCodeJournal | undefined;
        await dispatchMiraLocalCode(f.options, {
            execute: async (_config, _input, journal, stopping) => {
                retained = journal;
                await journal.creating(stopping);
                throw new Error("Lost create acknowledgement");
            },
            cleanup,
        });
        const pending = await f.read(job.id);
        expect(pending).toMatchObject({
            state: "needs_attention",
            cleanup: "pending",
            phase: "cleaning",
        });
        await rejects(retained!.created(containerId, signal), /lifecycle/);
        const next = await f.queue();
        expect(await dispatchMiraLocalCode(f.options, { execute, cleanup })).toBe(false);
        const waiting = await f.read(next.id);
        expect(waiting.state).toBe("queued");
        await f.client`UPDATE mira_daytona_jobs SET retry_at=NULL WHERE id=${job.id}`;
        let recovered = 0;
        await dispatchMiraLocalCode(f.options, {
            execute: () => Promise.reject(new Error("Must not replay")),
            cleanup: async (_config, _record, journal) => {
                recovered++;
                await journal.cleaning(signal);
                await journal.discovered(containerId, signal);
                await journal.cleaned(signal);
            },
        });
        expect(recovered).toBe(1);
        const reconciled = await f.read(job.id);
        expect(reconciled.cleanup).toBe("confirmed");
        expect(await dispatchMiraLocalCode(f.options, { execute, cleanup })).toBe(true);
        const completed = await f.read(next.id);
        expect(completed.state).toBe("completed");
    } finally {
        await f.close();
    }
});
