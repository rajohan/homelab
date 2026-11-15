import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { capabilities } from "@homelab/contracts/operations";
import { claimMiraRun, finishMiraRun } from "@homelab/mira/data/queue";

import { cleanupMiraConversations } from "../../../../mira/src/server/executor/cleanup";
import { maintainMiraContext } from "../../../../mira/src/server/executor/contextMaintenance";
import {
    inlineImages,
    inspectRolloutContext,
} from "../../../../mira/src/server/runtime/rolloutContext";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

test.each([
    "success",
    "compaction-failure",
    "lease-lost",
    "cleanup-failure",
    "unready",
    "cancel-before-track",
    "checkpoint-not-persisted",
])("visual context replacement is fenced and recoverable: %s", async (scenario) => {
    const fixture = await operationFixture();
    const home = await mkdtemp(path.join(tmpdir(), "mira-context-db-"));
    const original = crypto.randomUUID(),
        replacement = crypto.randomUUID();
    const filename = path.join(home, "sessions", `rollout-${original}.jsonl`);
    const image = `data:image/png;base64,${"A".repeat(128)}`;
    const item = {
        type: "message",
        role: "user",
        content: [
            {
                type: "input_text",
                text: "Preserve goal ZK-427 and unresolved action status.",
            },
            { type: "input_image", image_url: image },
        ],
    };
    const api = appRouter.createCaller({
        operations: fixture,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        await mkdir(path.dirname(filename));
        await writeFile(
            filename,
            [
                JSON.stringify({ type: "session_meta", payload: { id: original } }),
                JSON.stringify({
                    type: "compacted",
                    payload: {
                        replacement_history: [
                            item,
                            { type: "compaction", encrypted_content: "opaque-state" },
                        ],
                    },
                }),
            ].join("\n") + "\n"
        );
        const source = await inspectRolloutContext(home, original, filename);
        const chat = await api.conversations.create({ title: "Context repair" });
        await fixture.client`UPDATE mira_conversations SET provider_thread=${original},provider_context_ready=${scenario !== "unready"} WHERE id=${chat.id}`;
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Continue the same task",
        });
        const run = await claimMiraRun(fixture.client, crypto.randomUUID(), "foreground");
        if (!run) throw new Error("Expected claimed fixture run");
        const imported: unknown[] = [],
            retired: string[] = [],
            compacted: string[] = [];
        const runtime: Parameters<typeof maintainMiraContext>[0]["runtime"] = {
            readContext: async (id) =>
                id === original
                    ? inspectRolloutContext(home, original, filename)
                    : {
                          ...source,
                          threadId: replacement,
                          images: 0,
                          imageBytes: 0,
                          checkpointOffset:
                              scenario === "checkpoint-not-persisted"
                                  ? 0
                                  : source.checkpointOffset +
                                    compacted.filter((value) => value === replacement)
                                        .length,
                      },
            startThread: async () => {
                if (scenario === "cancel-before-track")
                    await fixture.client`UPDATE mira_runs SET cancel_requested=true WHERE id=${run.id}`;
                return replacement;
            },
            importContext: (_id, items) => {
                imported.push(...items);
                return Promise.resolve();
            },
            compactThread: async (id) => {
                compacted.push(id);
                if (id === original)
                    await appendFile(
                        filename,
                        JSON.stringify({
                            type: "compacted",
                            payload: {
                                replacement_history: [
                                    item,
                                    {
                                        type: "compaction",
                                        encrypted_content: "opaque-state",
                                    },
                                ],
                            },
                        }) + "\n"
                    );
                if (id === replacement && scenario === "compaction-failure")
                    throw new Error("Synthetic compaction failed");
                if (id === replacement && scenario === "lease-lost")
                    await fixture.client`UPDATE mira_runs SET lease_token=${crypto.randomUUID()} WHERE id=${run.id}`;
            },
            retireThread: async (id) => {
                const [row] = await fixture.client<
                    { reference: string }[]
                >`SELECT provider_thread AS reference FROM mira_conversations WHERE id=${chat.id}`;
                expect(row?.reference).toBe(replacement);
                retired.push(id);
                if (scenario === "cleanup-failure")
                    throw new Error("Synthetic deletion failed");
            },
        };
        const operation = maintainMiraContext({
            client: fixture.client,
            run,
            runtime,
            threadId: original,
            model: "fixture",
            workspace: home,
            tools: [],
            instructions: "Trusted policy",
            signal: new AbortController().signal,
            expireImages: true,
        });
        const succeeded = ["success", "cleanup-failure", "unready"].includes(scenario);
        if (succeeded) expect(await operation).toBe(replacement);
        else
            await expect(operation).rejects.toThrow(
                new Map([
                    ["lease-lost", "lease"],
                    ["cancel-before-track", "lease"],
                    ["checkpoint-not-persisted", "durably"],
                ]).get(scenario) ?? "compaction failed"
            );
        const [row] = await fixture.client<
            { reference: string; retired: string[]; ready: boolean }[]
        >`SELECT provider_thread AS reference, provider_retired_threads AS retired, provider_context_ready AS ready FROM mira_conversations WHERE id=${chat.id}`;
        expect(row?.reference).toBe(succeeded ? replacement : original);
        expect(retired).toEqual(succeeded ? [original] : []);
        expect(compacted).toEqual(
            scenario === "cancel-before-track" ? [original] : [original, replacement]
        );
        expect(row?.ready).toBe(scenario !== "unready");
        expect(inlineImages(imported).count).toBe(0);
        if (scenario !== "cancel-before-track") {
            expect(JSON.stringify(imported)).toContain("ZK-427");
            expect(JSON.stringify(imported)).toContain("opaque-state");
        }
        expect(await Bun.file(filename).text()).toContain(image);
        expect(row?.retired).toEqual(
            succeeded && scenario !== "cleanup-failure"
                ? []
                : [succeeded ? original : replacement]
        );
        // A background pass must never delete a candidate belonging to an active run.
        const cleaned: string[] = [];
        const cleanup = {
            deleteThread: (id: string) => {
                cleaned.push(id);
                return Promise.resolve();
            },
        };
        expect(await cleanupMiraConversations(fixture.client, cleanup)).toBe(0);
        await fixture.client`UPDATE mira_runs SET lease_token=${run.leaseToken} WHERE id=${run.id}`;
        await finishMiraRun(fixture.client, run, {
            state: "completed",
            text: "Fixture done",
            message: null,
        });
        expect(await cleanupMiraConversations(fixture.client, cleanup)).toBe(
            succeeded && scenario !== "cleanup-failure" ? 0 : 1
        );
        expect(cleaned).not.toContain(succeeded ? replacement : original);
    } finally {
        await fixture.close();
        await rm(home, { recursive: true, force: true });
    }
});

test.each([false, true])(
    "later cleanup success preserves an earlier failure's backoff; product deleted=%s",
    async (deleted) => {
        const fixture = await operationFixture();
        try {
            const id = crypto.randomUUID();
            await fixture.client`INSERT INTO mira_conversations(id,owner,title,provider_thread,provider_retired_threads,deleted_at) VALUES(${id},'operator','Backoff fixture','current',${JSON.stringify(["failing", "succeeding"])}::text::jsonb,${deleted ? new Date() : null})`;
            const attempted: string[] = [];
            const runtime = {
                deleteThread: (threadId: string) => {
                    attempted.push(threadId);
                    return threadId === "failing"
                        ? Promise.reject(new Error("Persistent fixture outage"))
                        : Promise.resolve();
                },
            };
            await expect(
                cleanupMiraConversations(fixture.client, runtime)
            ).rejects.toThrow("references remain pending");
            expect(attempted).toEqual(
                deleted ? ["failing", "succeeding", "current"] : ["failing", "succeeding"]
            );
            const [pending] = await fixture.client<
                { deferred: boolean; retired: string[] }[]
            >`SELECT provider_purge_retry_at>now() AS deferred,provider_retired_threads AS retired FROM mira_conversations WHERE id=${id}`;
            expect(pending).toEqual({ deferred: true, retired: ["failing"] });
            attempted.length = 0;
            expect(await cleanupMiraConversations(fixture.client, runtime)).toBe(0);
            expect(attempted).toEqual([]);
            await fixture.client`UPDATE mira_conversations SET provider_purge_retry_at=now()-interval '1 second' WHERE id=${id}`;
            expect(
                await cleanupMiraConversations(fixture.client, {
                    deleteThread: () => Promise.resolve(),
                })
            ).toBe(1);
            const [finished] = await fixture.client<
                { retry: Date | null }[]
            >`SELECT provider_purge_retry_at AS retry FROM mira_conversations WHERE id=${id}`;
            expect(finished?.retry).toBeNull();
        } finally {
            await fixture.close();
        }
    }
);
