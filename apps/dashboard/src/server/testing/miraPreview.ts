import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { capabilities } from "@homelab/contracts/operations";
import { installMiraPresets } from "@homelab/mira/data/automationActions";
import { createConversation, enqueueTurn } from "@homelab/mira/data/conversations";
import { createReport, saveMemory } from "@homelab/mira/data/documents";
import { saveMiraFile } from "@homelab/mira/data/files";
import { saveMiraMail } from "@homelab/mira/data/mail";
import { saveMiraPublication } from "@homelab/mira/data/publications";
import { claimMiraRun, finishMiraRun } from "@homelab/mira/data/queue";
import { saveTask } from "@homelab/mira/data/tasks";

import { createTestDatabase } from "../../../../../tests/database";
import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import { syntheticPdf } from "../../../../mira/src/server/testing/document";
import index from "../../index.html";
import { connectDashboardDatabase } from "../database/connection";
import { migrateDashboard } from "../database/migrations";
import { isSameOriginApiRequest } from "../http/requestOrigin";
import { dashboardApiRequest } from "../http/responses";
import { createJobRegistry } from "../jobs/registry";
import { miraFileRequest } from "../mira/files";
import { provisionTestAgentMail } from "./agentmail";
import { miraViewport } from "./miraViewport";

/**
 * Preview actual Mira components and APIs using disposable records and synthetic replies.
 * @param port - Dedicated loopback preview port; defaults to the established local preview.
 * @returns Completion after the loopback-only preview and its owned test data are removed.
 */
export async function main(port = 3330): Promise<void> {
    const allocation = await createTestDatabase();
    const database = connectDashboardDatabase(allocation.url, 6);
    const directory = await mkdtemp(path.join(tmpdir(), "mira-ui-preview-"));
    const context = {
        client: database.client,
        owner: "preview-operator",
        actor: "human:preview-operator",
    };
    const previewMail = {
        owner: context.owner,
        inboxId: "synthetic@agentmail.to",
        signingSecret: `whsec_${Buffer.from("synthetic-webhook-key-32-bytes-000").toString("base64")}`,
    };
    const previewHereNow = {
        owner: context.owner,
        accountId: "11111111-1111-4111-8111-111111111111",
    };
    const operations = {
        ...database,
        registry: createJobRegistry([]),
        miraFilesDirectory: directory,
        agentMailHook: previewMail,
        hereNowBinding: previewHereNow,
    };
    const principal = { kind: "human" as const, id: context.owner, capabilities };
    const worker = crypto.randomUUID();
    const origin = `http://localhost:${port}`;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    let pending: Promise<void> = Promise.resolve();
    let pumping = false;
    const stopped = Promise.withResolvers<void>();
    const stop = () => stopped.resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
        await migrateDashboard(database);
        await installMiraPresets(context);
        await provisionTestAgentMail(database.client, previewMail);
        await saveMemory(context, {
            title: "Design preference",
            content:
                "Use the existing Homelab design and shared components. This is synthetic preview data.",
        });
        const file = await saveMiraFile(context, directory, {
            id: crypto.randomUUID(),
            name: "Example report.pdf",
            bytes: syntheticPdf(),
        });
        for (let index = 1; index <= 18; index++)
            await createConversation(context, `Preview · Earlier conversation ${index}`);
        const chat = await createConversation(context, "Preview · Plan the week");
        const publicationFiles: { id: string; path: string }[] = [];
        for (const name of [
            "index.html",
            "about.html",
            "tasks.html",
            "reports.html",
            "maintenance.html",
            "contact.html",
            "privacy.html",
            "status.html",
        ]) {
            const page = await saveMiraFile(context, directory, {
                id: crypto.randomUUID(),
                name,
                bytes: new TextEncoder().encode("<h1>Synthetic publication preview</h1>"),
            });
            publicationFiles.push({ id: page.id, path: name });
        }
        await saveMiraPublication(
            context,
            {
                id: Bun.randomUUIDv7(),
                version: 0,
                conversationId: chat.id,
                content: {
                    title: "Dashboard improvement preview",
                    target: null,
                    visibility: "anyone_with_link",
                    files: publicationFiles,
                },
            },
            previewHereNow
        );

        await saveMiraMail(
            context,
            {
                id: Bun.randomUUIDv7(),
                version: 0,
                conversationId: chat.id,
                content: {
                    to: ["recipient@example.com"],
                    cc: ["copy@example.com"],
                    bcc: ["reviewer@example.com"],
                    subject: "Proposed dashboard improvement",
                    text: "Hello,\n\nHere is the reviewed plan for the dashboard improvement. This preview contains only synthetic recipients and content.\n\nNo provider or outgoing mail worker is connected.\n\nRegards,\nMira",
                },
            },
            previewMail
        );

        await saveMiraMail(
            context,
            {
                id: Bun.randomUUIDv7(),
                version: 0,
                conversationId: chat.id,
                content: {
                    to: ["requester@example.com"],
                    cc: [],
                    bcc: [],
                    subject: "Maintenance plan",
                    text: "Hello,\n\nThe maintenance plan is ready for review. This is a synthetic reply and cannot send real email.\n\nRegards,\nMira",
                    attachmentIds: [file.id],
                },
            },
            previewMail,
            {
                messageId: "<preview-original@example.com>",
                threadId: "preview-thread",
                from: "Example requester <requester@example.com>",
                subject: "Maintenance plan",
            }
        );

        await database.client.begin((query) =>
            enqueueTurn(query, context, {
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Help me plan the next improvements. Keep the dashboard work separate from routine updates.",
                attachmentIds: [file.id],
            })
        );
        const initial = await claimMiraRun(database.client, worker, "foreground");
        if (!initial) throw new Error("Preview seed could not claim its own run.");
        await createMiraTools(database.client, initial)
            .find((tool) => tool.name === "mira_memory_create")!
            .execute(
                {
                    title: "Preferred maintenance window",
                    content:
                        "Schedule routine maintenance on Sunday mornings. This is a synthetic suggestion awaiting your review.",
                },
                new AbortController().signal,
                { callId: "preview-proposal", threadId: "synthetic", turnId: "synthetic" }
            );
        await finishMiraRun(database.client, initial, {
            state: "completed",
            message: null,
            text: "I would start with these tasks:\n\n| Task | Next step |\n| --- | --- |\n| Review storage usage | Check the recorded observations |\n| Improve the dashboard | Prepare one small, tested change |\n\nThe improvement automation can stay paused while routine update checks continue.\n\nThis is an interactive preview with synthetic data. No model or production service is connected.",
        });
        for (const [position, status] of (
            ["todo", "in_progress", "blocked", "done"] as const
        ).entries()) {
            await saveTask(context, {
                title: [
                    "Review storage usage",
                    "Qualify Mira attachments",
                    "Review a proposed deployment",
                    "Verify the release images",
                ][position]!,
                description: "Synthetic task for reviewing the shared task-board design.",
                status,
                assignee: position % 2 ? "mira" : "operator",
                priority: position === 2 ? "high" : "normal",
                labels: ["preview", "homelab"],
                dueAt:
                    position === 0
                        ? new Date(Date.now() + 86_400_000).toISOString()
                        : null,
                completionCriteria:
                    "The requested change has been verified and recorded.",
                conversationId: null,
            });
        }
        await createReport(
            context,
            {
                title: "Morning brief · Preview",
                kind: "brief",
                taskId: null,
                markdown:
                    "## Today\n\nThe attachment qualification passed. One deployment is waiting for review.\n\n- **Completed:** text, PDF and image handling\n- **Next:** review the interface\n- **Paused intentionally:** dashboard improvement\n\nThis report contains synthetic data.",
            },
            initial.id
        );
        const pump = async () => {
            await database.client`INSERT INTO mira_runtime_status (id, worker_id, version, model, ready, message, heartbeat_at) VALUES (1, ${worker}, 'preview', 'Synthetic replies', true, 'Interactive preview only. No production or provider connection.', now()) ON CONFLICT (id) DO UPDATE SET heartbeat_at = now()`;
            const run = await claimMiraRun(database.client, worker, "foreground");
            if (run)
                await finishMiraRun(database.client, run, {
                    state: "completed",
                    message: null,
                    text: "This preview received your message and saved the conversation. Replies here are synthetic; no model request or production operation was performed. You can review files, memory, tasks, reports and automation controls.",
                });
        };
        await pump();
        interval = setInterval(() => {
            if (pumping) return;
            pumping = true;
            pending = pump()
                .catch(() => stop())
                .finally(() => {
                    pumping = false;
                });
        }, 1500);
        server = serveMiraPreview({ operations, principal, origin, port });
        process.stdout.write(`Mira synthetic preview: ${origin}/mira/${chat.id}\n`);
        await stopped.promise;
    } finally {
        clearInterval(interval);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await pending;
        await server?.stop(true);
        await database.client.close();
        await allocation.close();
        await rm(directory, { recursive: true, force: true });
    }
}

/**
 * Serve the actual dashboard against an explicitly owned disposable preview allocation.
 * @param options - Synthetic operations and identity, expected browser origin and loopback port.
 * @returns The owned server handle, so source revisions can reuse preview data during review.
 */
export function serveMiraPreview({
    operations,
    principal,
    origin,
    port,
}: {
    operations: NonNullable<Parameters<typeof dashboardApiRequest>[1]>["operations"];
    principal: NonNullable<Parameters<typeof dashboardApiRequest>[1]>["principal"];
    origin: string;
    port: number;
}) {
    const api = (request: Request) => {
        if (!isSameOriginApiRequest(request, origin))
            return Response.json({ message: "Invalid preview origin" }, { status: 403 });
        return dashboardApiRequest(request, { operations, principal });
    };
    return Bun.serve({
        hostname: "127.0.0.1",
        port,
        development: true,
        maxRequestBodySize: 26_214_400,
        routes: {
            "/preview": miraViewport,
            "/api/session": () =>
                Response.json({
                    authenticated: true,
                    mfaRequired: false,
                    methods: [],
                    username: "Preview",
                    userId: principal?.id ?? "preview-operator",
                    sessionId: "disposable-preview",
                }),
            "/api/trpc": api,
            "/api/trpc/*": api,
            "/api/mira/files": (request) =>
                isSameOriginApiRequest(request, origin)
                    ? miraFileRequest(request, { operations, principal })
                    : new Response(null, { status: 403 }),
            "/api/mira/files/*": (request) =>
                isSameOriginApiRequest(request, origin)
                    ? miraFileRequest(request, { operations, principal })
                    : new Response(null, { status: 403 }),
            "/api/*": () =>
                Response.json(
                    { message: "Unavailable in the synthetic preview" },
                    { status: 404 }
                ),
            "/*": index,
        },
    });
}

if (import.meta.main) await main();
