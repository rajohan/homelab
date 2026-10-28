import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { capabilities } from "@homelab/contracts/operations";
import { installMiraPresets } from "@homelab/mira/data/automationActions";
import { saveMiraCode } from "@homelab/mira/data/code";
import {
    createMiraComputerPairing,
    enrollMiraComputer,
    connectMiraComputer,
} from "@homelab/mira/data/computers";
import { createConversation, enqueueTurn } from "@homelab/mira/data/conversations";
import { saveMiraDaytona } from "@homelab/mira/data/daytona";
import { createReport, saveMemory } from "@homelab/mira/data/documents";
import { saveMiraFile } from "@homelab/mira/data/files";
import { saveMiraMail } from "@homelab/mira/data/mail";
import { saveMiraPublication } from "@homelab/mira/data/publications";
import { claimMiraRun, finishMiraRun } from "@homelab/mira/data/queue";
import { saveMiraSocial } from "@homelab/mira/data/social";
import { saveTask } from "@homelab/mira/data/tasks";
import { miraSkillCatalogHash } from "@homelab/mira/skills/catalog";

import { createTestDatabase } from "../../../../../tests/database";
import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import { daytonaEditContent } from "../../../../mira/src/server/sandbox/profile";
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
    const previewMoltbook = { owner: context.owner, agentName: "SyntheticMira" };
    const previewDaytona = {
        owner: context.owner,
        trustBoundary: "dedicated-organization" as const,
        networkAccess: "provider-default" as const,
        organizationId: "11111111-1111-4111-8111-111111111111",
        snapshotId: "22222222-2222-4222-8222-222222222222",
        target: "eu",
    };
    const operations = {
        ...database,
        registry: createJobRegistry([]),
        releaseRepository: "demo/homelab",
        miraFilesDirectory: directory,
        agentMailHook: previewMail,
        hereNowBinding: previewHereNow,
        moltbookBinding: previewMoltbook,
        daytonaBinding: previewDaytona,
        githubBinding: { owner: context.owner },
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
        await database.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('homelab.release',${JSON.stringify({ repository: "demo/homelab", verified: true, computer: { version: "0.11.0", revision: "a".repeat(40), size: 123, sha256: "b".repeat(64), url: "https://github.com/demo/homelab/releases/download/v0.11.0/mira-computer-0.11.0-windows-x64-setup.exe" } })}::text::jsonb,now())`;
        for (const [label, online] of [
            ["Windows desktop", true],
            ["Laptop", false],
        ] as const) {
            const ticket = await createMiraComputerPairing(context, { label });
            const device = await enrollMiraComputer(database.client, ticket.token, {
                installationId: crypto.randomUUID(),
                platform: "win32",
                version: "0.10.0",
            });
            if (online)
                await connectMiraComputer(database.client, device.credential, {
                    version: "0.10.0",
                });
        }
        await createMiraComputerPairing(context, { label: "New computer" });
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
        const cloudFile = await saveMiraFile(context, directory, {
            id: crypto.randomUUID(),
            name: "Cloud result.json",
            bytes: new TextEncoder().encode(
                '{"bun":"1.4.4","checks":"passed","synthetic":true}'
            ),
        });
        for (const state of ["completed", "needs_attention", "draft"] as const) {
            const id = Bun.randomUUIDv7();
            await saveMiraDaytona(
                context,
                {
                    id,
                    version: 0,
                    conversationId: chat.id,
                    taskId: null,
                    content: {
                        title: {
                            draft: "Check the Bun runtime",
                            needs_attention: "Resolve interrupted sandbox cleanup",
                            completed: "Generate a qualification report",
                        }[state],
                        command: `bun --version\nmkdir -p /tmp/homelab-mira/${id}/outputs\nprintf '{"synthetic":true}\\n' > /tmp/homelab-mira/${id}/outputs/result.json`,
                        inputs: [],
                        outputs: ["result.json"],
                    },
                },
                previewDaytona
            );
            if (state !== "draft")
                await database.client`UPDATE mira_daytona_jobs SET deadline=clock_timestamp()-interval '15 minutes',state=${state},phase=${state === "completed" ? "closed" : "cleaning"},cleanup=${state === "completed" ? "confirmed" : "pending"},exit_code=0,stdout='Bun 1.4.4\nBuild completed\nAll checks passed\n',files=${JSON.stringify([{ name: "result.json", id: cloudFile.id }])}::text::jsonb WHERE id=${id}`;
        }
        const edits = await saveMiraFile(context, directory, {
            id: Bun.randomUUIDv7(),
            name: "Example edits.json",
            bytes: new TextEncoder().encode(
                JSON.stringify(
                    {
                        version: 1,
                        commit: "a".repeat(40),
                        files: [
                            {
                                path: "apps/dashboard/src/browser/example.ts",
                                beforeSha256: null,
                                content: 'export const title = "Clearer job status";\n',
                            },
                        ],
                    },
                    null,
                    2
                )
            ),
        });
        const [editFile] = await database.client<
            { sha256: string }[]
        >`SELECT sha256 FROM mira_attachments WHERE id=${edits.id}`;
        for (const state of ["draft", "published", "needs_attention"] as const) {
            const jobId = Bun.randomUUIDv7();
            await saveMiraDaytona(
                context,
                {
                    id: jobId,
                    version: 0,
                    conversationId: chat.id,
                    taskId: null,
                    content: daytonaEditContent(
                        {
                            id: jobId,
                            commit: "a".repeat(40),
                            editsSha256: editFile!.sha256,
                        },
                        { id: edits.id, sha256: editFile!.sha256 }
                    ),
                },
                previewDaytona
            );
            await database.client`UPDATE mira_daytona_jobs SET state='completed',outcome='completed',cleanup='confirmed',phase='closed',exit_code=0 WHERE id=${jobId}`;
            const draft = await saveMiraCode(
                context,
                {
                    id: Bun.randomUUIDv7(),
                    version: 0,
                    conversationId: chat.id,
                    content: {
                        title: {
                            draft: "fix(dashboard): clarify job progress",
                            published: "fix(dashboard): align mobile actions",
                            needs_attention: "fix(dashboard): recover publication status",
                        }[state],
                        body: "Show clear progress and keep the actions aligned on smaller screens.\n\nValidation: synthetic preview data only.",
                        checkId: jobId,
                        commit: "a".repeat(40),
                    },
                },
                { owner: context.owner }
            );
            if (state !== "draft")
                await database.client`UPDATE mira_code_publications SET state=${state},approved_version=1,approved_by=${context.actor},approved_at=now(),control_version=1,attempt_token=${crypto.randomUUID()},started_at=now(),phase=${state === "published" ? "pull_request:confirmed" : "pull_request:sending"},branch=${`mira/publication/${draft.id}`},commit=${"d".repeat(40)},number=${state === "published" ? 123 : null},message=${state === "published" ? "Synthetic draft PR created. No real GitHub request was sent." : "Synthetic interrupted publication. Inspect the outcome before any further action."} WHERE id=${draft.id}`;
        }
        await database.client`INSERT INTO mira_switches(owner,key,enabled,reason) VALUES(${context.owner},'integration:daytona',false,'Synthetic recovery preview; no provider connected.')`;
        await saveMiraSocial(
            context,
            {
                id: Bun.randomUUIDv7(),
                version: 0,
                conversationId: chat.id,
                content: {
                    kind: "post",
                    community: "testing",
                    title: "A small dashboard improvement",
                    text: "The new dashboard keeps background work separate from interactive tasks.\n\nLong-running maintenance no longer prevents a quick status check. This is synthetic preview content, with no Moltbook account or publishing worker connected.",
                },
            },
            previewMoltbook
        );
        const reply = await saveMiraSocial(
            context,
            {
                id: Bun.randomUUIDv7(),
                version: 0,
                conversationId: chat.id,
                content: {
                    kind: "comment",
                    postId: "synthetic-post",
                    parentId: "synthetic-parent",
                    text: "Thanks for the suggestion. I added an independent pause control and checked the mobile layout.",
                },
            },
            previewMoltbook
        );
        await database.client`UPDATE mira_social_drafts SET state='verification_required',provider_id='synthetic-comment',verification_code='synthetic-code',challenge='Synthetic preview challenge. Enter a numeric answer such as 15.00.',expires_at=now()+interval '5 minutes',approved_version=1,approved_by=${context.actor},approved_at=now(),control_stamp='2:2',message='Synthetic preview only; there is no provider connection.' WHERE id=${reply.id}`;
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
        await createMiraTools(database.client, initial, directory)
            .find((tool) => tool.name === "mira_file_create")!
            .execute(
                {
                    name: "Preview report.md",
                    content:
                        "# Synthetic report\n\nThis file was generated through the actual Mira tool using disposable preview data.\n",
                },
                new AbortController().signal,
                {
                    callId: "preview-generated-file",
                    threadId: "synthetic",
                    turnId: "synthetic",
                }
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
        const computerChat = await createConversation(
            context,
            "Preview · Computer access"
        );
        await database.client.begin((query) =>
            enqueueTurn(query, context, {
                conversationId: computerChat.id,
                requestId: crypto.randomUUID(),
                text: "Help me inspect a window on my PC. This is a synthetic preview; no real computer is connected.",
                attachmentIds: [],
            })
        );
        const computerRun = await claimMiraRun(database.client, worker, "general");
        if (!computerRun)
            throw new Error("Computer preview could not claim its synthetic run.");
        await database.client`UPDATE mira_runs SET budget_seconds=3600 WHERE id=${computerRun.id}`;
        const computerReceipt = crypto.randomUUID();
        await database.client`INSERT INTO mira_tool_receipts (id,run_id,call_id,tool,input_hash,state)
            VALUES (${computerReceipt},${computerRun.id},'synthetic-computer-wait','mira_computer_wait',${"a".repeat(64)},'running')`;
        const pump = async () => {
            // Only this disposable preview lease is kept alive; no executor or native host is connected.
            const [showcase] = await database.client<
                { cancelRequested: boolean; expired: boolean }[]
            >`
                SELECT cancel_requested AS "cancelRequested", started_at+budget_seconds*interval '1 second'<=clock_timestamp() AS expired
                FROM mira_runs WHERE id=${computerRun.id} AND state='running' AND lease_token=${computerRun.leaseToken}`;
            if (showcase?.cancelRequested || showcase?.expired) {
                await database.client`UPDATE mira_tool_receipts SET state='failed',message='Synthetic wait ended without a computer action.',finished_at=now()
                    WHERE id=${computerReceipt} AND state='running'`;
                await finishMiraRun(database.client, computerRun, {
                    state: showcase.cancelRequested ? "interrupted" : "completed",
                    text: "The synthetic computer preview stopped. No real computer was connected.",
                    message: null,
                });
            } else if (showcase) {
                await database.client`UPDATE mira_runs SET lease_expires_at=now()+interval '45 seconds' WHERE id=${computerRun.id} AND state='running' AND NOT cancel_requested`;
            }

            await database.client`UPDATE mira_computers SET last_seen_at=now(),connection_expires_at=now()+interval '45 seconds' WHERE owner=${context.owner} AND label='Windows desktop' AND state='paired'`;
            await database.client`INSERT INTO mira_runtime_status (id, worker_id, version, model, ready, message, heartbeat_at, skill_catalog_hash, skill_catalog_worker_id) VALUES (1, ${worker}, 'preview', 'synthetic-visual', true, 'Interactive preview only. No production or provider connection.', now(), ${miraSkillCatalogHash}, ${worker}) ON CONFLICT (id) DO UPDATE SET worker_id = EXCLUDED.worker_id, heartbeat_at = now(), skill_catalog_hash = EXCLUDED.skill_catalog_hash, skill_catalog_worker_id = EXCLUDED.skill_catalog_worker_id`;
            await database.client`UPDATE mira_runtime_status SET models=${JSON.stringify([{ model: "synthetic-visual", displayName: "Synthetic replies", isDefault: true, inputModalities: ["text", "image"] }])}::text::jsonb WHERE id=1`;
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
        process.stdout.write(`Computer preview: ${origin}/mira/${computerChat.id}\n`);
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
        return dashboardApiRequest(request, {
            operations,
            principal,
            verifyHuman: () =>
                principal
                    ? Promise.resolve(principal)
                    : Promise.reject(new Error("No preview principal")),
        });
    };
    return Bun.serve({
        hostname: "127.0.0.1",
        port,
        development: true,
        maxRequestBodySize: 26_214_400,
        routes: {
            "/preview": miraViewport,
            "/api/account": {
                GET: () =>
                    Response.json({
                        user: {
                            id: principal?.id ?? "preview-operator",
                            username: "Preview",
                            email: "preview@example.test",
                            emailVerified: true,
                        },
                        factors: [],
                        recoveryCodesRemaining: 0,
                        applications: [],
                        sessions: [
                            {
                                id: "disposable-preview",
                                userAgent: "Synthetic preview",
                                current: true,
                                createdAt: new Date().toISOString(),
                                lastSeenAt: new Date().toISOString(),
                                expiresAt: new Date(
                                    Date.now() + 86_400_000
                                ).toISOString(),
                            },
                        ],
                    }),
            },
            "/api/account/activity": {
                GET: () => Response.json({ events: [], nextCursor: null }),
            },
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
