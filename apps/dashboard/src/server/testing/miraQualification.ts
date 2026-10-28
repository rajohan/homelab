import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { saveMiraChatSettings } from "@homelab/mira/data/chatSettings";

import { createTestDatabase } from "../../../../../tests/database";
import { runtimeEnvironment } from "../../../../mira/src/server/config/environment";
import {
    changeConversation,
    createConversation,
    enqueueTurn,
    readConversation,
} from "../../../../mira/src/server/data/conversations";
import { saveMiraFile } from "../../../../mira/src/server/data/files";
import {
    claimMiraRun,
    finishMiraRun,
    renewMiraRun,
} from "../../../../mira/src/server/data/queue";
import { cleanupMiraConversations } from "../../../../mira/src/server/executor/cleanup";
import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import { executeMiraTurn } from "../../../../mira/src/server/executor/turn";
import { CodexRuntime } from "../../../../mira/src/server/runtime/codexRuntime";
import { pilotArguments } from "../../../../mira/src/server/runtime/configuration";
import { validatePilot } from "../../../../mira/src/server/runtime/validatePilot";
import { syntheticPdf } from "../../../../mira/src/server/testing/document";
import { syntheticRedImage } from "../../../../mira/src/server/testing/image";
import { connectDashboardDatabase } from "../database/connection";
import { migrateDashboard } from "../database/migrations";

/**
 * Qualify the real executor, owned file pipeline and durable product state with synthetic content.
 * @returns Completion after restoring conversation context and deleting this test's provider history.
 */
export async function main(): Promise<void> {
    const file = process.argv[2];
    if (!file || process.argv.length !== 3)
        throw new Error("Usage: bun run mira:qualify-product /absolute/pilot.json");
    const config = await validatePilot(await Bun.file(file).json());
    const allocation = await createTestDatabase();
    const database = connectDashboardDatabase(allocation.url, 6);
    const directory = await mkdtemp(path.join(tmpdir(), "mira-product-qualification-"));
    const context = {
        client: database.client,
        owner: "synthetic-qualification",
        actor: "human:synthetic-qualification",
    };
    const conversationIds: string[] = [];
    try {
        await migrateDashboard(database);
        const marker = crypto.randomUUID();
        const attachments = [];
        for (const [name, bytes] of [
            ["marker.txt", new TextEncoder().encode(`Synthetic marker: ${marker}`)],
            ["document.pdf", syntheticPdf()],
            ["colour.png", syntheticRedImage()],
        ] as const)
            attachments.push(
                await saveMiraFile(context, directory, {
                    id: crypto.randomUUID(),
                    name,
                    bytes,
                })
            );
        const conversation = await createConversation(
            context,
            "Synthetic product qualification"
        );
        conversationIds.push(conversation.id);
        const turn = async (text: string, attachmentIds: string[] = []) => {
            await database.client.begin((query) =>
                enqueueTurn(query, context, {
                    conversationId: conversation.id,
                    requestId: crypto.randomUUID(),
                    text,
                    attachmentIds,
                })
            );
            const run = await claimMiraRun(
                database.client,
                crypto.randomUUID(),
                "foreground"
            );
            assert.ok(run);
            await executeMiraTurn(
                database.client,
                config,
                run,
                new AbortController().signal,
                directory
            );
            const result = await readConversation(context, conversation.id);
            assert.equal(
                result.run?.state,
                "completed",
                "Synthetic executor turn did not complete."
            );
            return result.messages.at(-1)?.content ?? "";
        };
        const first = await turn(
            "This is a synthetic qualification. Read the attached text and PDF, and inspect the image. Call mira_tasks_list once with an empty search. Reply in English with the exact marker from the text, the phrase printed in the PDF, and the image's dominant colour. Remember the marker for the next turn.",
            attachments.map((entry) => entry.id)
        );
        assert.ok(first.includes(marker), "Text attachment marker was not read.");
        assert.match(first, /Synthetic Mira document/i, "PDF content was not read.");
        assert.match(first, /\bred\b/i, "Image was not recognized.");
        const calls = await database.client<
            { tool: string }[]
        >`SELECT tool FROM mira_tool_receipts WHERE state = 'succeeded'`;
        assert.ok(
            calls.some((call) => call.tool === "mira_tasks_list"),
            "Product tool invocation missing."
        );
        process.stdout.write(
            "Passed real executor turn with owned text, PDF, image and recorded product tool.\n"
        );
        const catalogRuntime = await CodexRuntime.connect({
            command: config.command,
            args: pilotArguments(),
            cwd: config.workspace,
            env: runtimeEnvironment(config),
        });
        let changedModel: string;
        try {
            const catalog = await catalogRuntime.models();
            const current = catalog.find((entry) => entry.isDefault)!;
            const choice =
                catalog.find((entry) => entry.model.includes("luna")) ??
                catalog.find((entry) => entry.model !== current.model) ??
                current;
            changedModel = choice.model;
            await database.client`INSERT INTO mira_runtime_status (id, worker_id, version, model, models, ready, heartbeat_at) VALUES (1, ${crypto.randomUUID()}, 'qualification', ${current.model}, ${JSON.stringify(catalog)}::text::jsonb, true, now())`;
            const beforeChange = await readConversation(context, conversation.id);
            await saveMiraChatSettings(context, {
                id: conversation.id,
                version: beforeChange.conversation.version,
                settings: {
                    model: choice.model,
                    effort: choice.defaultReasoningEffort,
                    serviceTier: null,
                },
            });
        } finally {
            await catalogRuntime.close();
        }
        const resumed = await turn(
            "Repeat the marker from the previous message exactly. Do not read files or call tools."
        );
        assert.ok(
            resumed.includes(marker),
            "Runtime replacement lost the conversation marker."
        );
        process.stdout.write(
            `Passed product conversation continuation after runtime replacement and model selection (${changedModel}).\n`
        );
        const stored = await readConversation(context, conversation.id);
        await changeConversation(context, {
            id: conversation.id,
            version: stored.conversation.version,
            action: "delete",
        });
        const runtime = await CodexRuntime.connect({
            command: config.command,
            args: pilotArguments(),
            cwd: config.workspace,
            env: runtimeEnvironment(config),
        });
        try {
            assert.equal(await cleanupMiraConversations(database.client, runtime), 1);
        } finally {
            await runtime.close();
        }
        process.stdout.write("Passed product and provider conversation deletion.\n");
        const legacy = await createConversation(
            context,
            "Synthetic pre-router conversation"
        );
        conversationIds.push(legacy.id);
        const legacyMarker = crypto.randomUUID();
        const firstLegacyText = `Call mira_tasks_list once with an empty search. Remember this synthetic marker: ${legacyMarker}. Reply with the marker.`;
        await database.client.begin((query) =>
            enqueueTurn(query, context, {
                conversationId: legacy.id,
                requestId: crypto.randomUUID(),
                text: firstLegacyText,
                attachmentIds: [],
            })
        );
        const legacyRun = await claimMiraRun(
            database.client,
            crypto.randomUUID(),
            "foreground"
        );
        assert.ok(legacyRun);
        const legacyRuntime = await CodexRuntime.connect({
            command: config.command,
            args: pilotArguments(),
            cwd: config.workspace,
            env: runtimeEnvironment(config),
        });
        const renewing = setInterval(() => {
            void renewMiraRun(database.client, legacyRun).catch(() => {});
        }, 5000);
        try {
            const catalog = await legacyRuntime.models();
            const model = config.model ?? catalog.find((entry) => entry.isDefault)!.model;
            const thread = await legacyRuntime.startThread(
                model,
                config.workspace,
                createMiraTools(database.client, legacyRun, directory),
                "This is a synthetic legacy qualification. Use only the supplied named product tools and preserve the test marker. Do not use external services."
            );
            await database.client`UPDATE mira_conversations SET provider_thread = ${thread}, model = ${model} WHERE id = ${legacy.id}`;
            const result = await legacyRuntime.turn(thread, firstLegacyText);
            assert.equal(result.status, "completed");
            assert.ok(result.text.includes(legacyMarker));
            await finishMiraRun(database.client, legacyRun, {
                state: result.status,
                text: result.text,
                message: null,
                providerTurn: result.id,
            });
        } finally {
            clearInterval(renewing);
            await legacyRuntime.close();
        }
        await database.client.begin((query) =>
            enqueueTurn(query, context, {
                conversationId: legacy.id,
                requestId: crypto.randomUUID(),
                text: "Call mira_tasks_list again with an empty search using the tool offered in this conversation, then repeat the marker from the earlier message exactly.",
                attachmentIds: [],
            })
        );
        const resumedLegacy = await claimMiraRun(
            database.client,
            crypto.randomUUID(),
            "foreground"
        );
        assert.ok(resumedLegacy);
        await executeMiraTurn(
            database.client,
            config,
            resumedLegacy,
            new AbortController().signal,
            directory
        );
        const legacyResult = await readConversation(context, legacy.id);
        assert.equal(legacyResult.run?.state, "completed");
        assert.ok(
            legacyResult.messages.at(-1)?.content.includes(legacyMarker),
            "Legacy resume lost the original conversation marker."
        );
        const legacyReceipts = await database.client<
            { tool: string }[]
        >`SELECT tool FROM mira_tool_receipts WHERE run_id = ${resumedLegacy.id} AND state = 'succeeded'`;
        assert.ok(
            legacyReceipts.some((receipt) => receipt.tool === "mira_tasks_list"),
            "Resumed legacy thread lost direct product tool access."
        );
        process.stdout.write(
            "Passed pre-router conversation continuation with its persisted direct tool catalog and current fenced handlers.\n"
        );
    } finally {
        try {
            if (conversationIds.length > 0) {
                // Keep provider cleanup retryable even if a qualification assertion fails.
                for (const conversationId of conversationIds)
                    await database.client`UPDATE mira_conversations SET deleted_at = coalesce(deleted_at,now()) WHERE id = ${conversationId}`;
                const runtime = await CodexRuntime.connect({
                    command: config.command,
                    args: pilotArguments(),
                    cwd: config.workspace,
                    env: runtimeEnvironment(config),
                });
                try {
                    await cleanupMiraConversations(database.client, runtime);
                } finally {
                    await runtime.close();
                }
            }
        } finally {
            try {
                await database.client.close();
            } finally {
                try {
                    await allocation.close();
                } finally {
                    await rm(directory, { recursive: true, force: true });
                }
            }
        }
    }
}

if (import.meta.main) await main();
