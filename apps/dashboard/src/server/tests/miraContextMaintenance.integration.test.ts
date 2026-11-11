import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test.each(["success", "compaction-failure", "lease-lost", "cleanup-failure"])(
    "visual context replacement is fenced and recoverable: %s",
    async (scenario) => {
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
            await fixture.client`UPDATE mira_conversations SET provider_thread=${original},provider_context_ready=true WHERE id=${chat.id}`;
            await api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Continue the same task",
            });
            const run = await claimMiraRun(
                fixture.client,
                crypto.randomUUID(),
                "foreground"
            );
            if (!run) throw new Error("Expected claimed fixture run");
            const imported: unknown[] = [],
                retired: string[] = [],
                compacted: string[] = [];
            const runtime: Parameters<typeof maintainMiraContext>[0]["runtime"] = {
                readContext: (id) =>
                    Promise.resolve(
                        id === original
                            ? source
                            : {
                                  ...source,
                                  threadId: replacement,
                                  images: 0,
                                  imageBytes: 0,
                              }
                    ),
                startThread: () => Promise.resolve(replacement),
                importContext: (_id, items) => {
                    imported.push(...items);
                    return Promise.resolve();
                },
                compactThread: async (id) => {
                    compacted.push(id);
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
            const succeeded = scenario === "success" || scenario === "cleanup-failure";
            if (succeeded) expect(await operation).toBe(replacement);
            else
                await expect(operation).rejects.toThrow(
                    scenario === "lease-lost" ? "lease" : "compaction failed"
                );
            const [row] = await fixture.client<
                { reference: string; retired: string[] }[]
            >`SELECT provider_thread AS reference, provider_retired_threads AS retired FROM mira_conversations WHERE id=${chat.id}`;
            expect(row?.reference).toBe(succeeded ? replacement : original);
            expect(retired).toEqual(succeeded ? [original] : []);
            expect(compacted).toEqual([original, replacement]);
            expect(inlineImages(imported).count).toBe(0);
            expect(JSON.stringify(imported)).toContain("ZK-427");
            expect(JSON.stringify(imported)).toContain("opaque-state");
            expect(await Bun.file(filename).text()).toContain(image);
            expect(row?.retired).toEqual(
                scenario === "success" ? [] : [succeeded ? original : replacement]
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
                scenario === "success" ? 0 : 1
            );
            expect(cleaned).not.toContain(succeeded ? replacement : original);
        } finally {
            await fixture.close();
            await rm(home, { recursive: true, force: true });
        }
    }
);
