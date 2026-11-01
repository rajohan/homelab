import {
    miraDefaultChatSettings,
    type MiraPermissionMode,
} from "@homelab/contracts/mira";
import { claimMiraRun } from "@homelab/mira/data/queue";
import type { SQL } from "bun";

import type { RuntimeTool } from "../../../../mira/src/server/runtime/protocol";
import type { appRouter } from "../api/router";

/**
 * Start a real synthetic Chat run with an explicit human-selected permission mode.
 * @param client - Disposable integration database.
 * @param api - Authenticated synthetic Mira caller.
 * @param mode - Conversation permission to freeze at admission.
 * @param target - Selected execution location, without provisioning a real provider.
 * @returns Claimed run and its exact fenced model context.
 */
export async function permissionRun(
    client: SQL,
    api: ReturnType<typeof appRouter.createCaller>["mira"],
    mode: MiraPermissionMode,
    target: "main" | "daytona" = "daytona"
) {
    const chat = await api.conversations.create({ title: "Permission qualification" });
    await api.conversations.settings({
        id: chat.id,
        version: 1,
        settings: {
            ...miraDefaultChatSettings,
            permissionMode: mode,
            executionTarget: target,
        },
    });
    const queued = await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Perform the synthetic requested work.",
    });
    const run = await claimMiraRun(client, crypto.randomUUID(), "foreground");
    if (!run || run.id !== queued.id)
        throw new Error("Expected the synthetic permission run.");
    return {
        run,
        context: {
            client,
            owner: run.owner,
            actor: `mira:${run.id}`,
            run: { id: run.id, leaseToken: run.leaseToken },
        },
    };
}

/**
 * Exercise the real transactional execution tool with a current draft snapshot.
 * @param tools - Real tool declarations from a synthetic owned run.
 * @param kind - Fixed draft type.
 * @param draft - Saved version and hash, never generated test guesses.
 * @returns Parsed passive result for assertions, including refused attempts.
 */
export async function permissionAction(
    tools: RuntimeTool[],
    kind: string,
    draft: { id: string; version: number; contentHash: string }
): Promise<unknown> {
    const tool = tools.find((entry) => entry.name === "mira_action_execute");
    if (!tool) throw new Error("Expected delegated execution tool.");
    const result = await tool.execute(
        { kind, id: draft.id, version: draft.version, contentHash: draft.contentHash },
        new AbortController().signal,
        { callId: crypto.randomUUID(), threadId: "fixture", turnId: "fixture" }
    );
    return JSON.parse(result) as unknown;
}
