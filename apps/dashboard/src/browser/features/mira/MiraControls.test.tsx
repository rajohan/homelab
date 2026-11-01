import { expect, spyOn, test } from "bun:test";

import {
    miraDefaultChatSettings,
    miraModelSchema,
    miraTaskUpdateSchema,
} from "@homelab/contracts/mira";
import type { MiraAttachment } from "@homelab/contracts/mira";
import type { MiraCodePublication } from "@homelab/contracts/miraCode";
import type { MiraDaytonaJob } from "@homelab/contracts/miraDaytona";
import type { MiraMailDraft } from "@homelab/contracts/miraMail";
import type { MiraPublication } from "@homelab/contracts/miraPublication";
import type { MiraSkillSummary } from "@homelab/contracts/miraSkills";
import type { MiraSocialDraft } from "@homelab/contracts/miraSocial";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { serialize } from "superjson";
import * as v from "valibot";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { AttachmentPicker } from "./AttachmentPicker";
import { AutomationEditor } from "./AutomationEditor";
import { ChatActivity } from "./ChatActivity";
import { ChatComposer } from "./ChatComposer";
import { ChatMessage } from "./ChatMessage";
import { ChatSettings } from "./ChatSettings";
import { CodeEditor } from "./CodeEditor";
import { CodeLibrary } from "./CodeLibrary";
import { CodeReview } from "./CodeReview";
import { DaytonaDetails } from "./DaytonaDetails";
import { DaytonaEditor } from "./DaytonaEditor";
import { DaytonaJobs } from "./DaytonaJobs";
import { DaytonaRecovery } from "./DaytonaRecovery";
import { ImprovementPermission } from "./ImprovementPermission";
import { MailEditor } from "./MailEditor";
import { MailReview } from "./MailReview";
import { MiraRunTable } from "./MiraRunTable";
import { MiraSkills } from "./MiraSkills";
import { ModelSettings } from "./ModelSettings";
import { ProposalReview } from "./ProposalReview";
import { PublicationEditor } from "./PublicationEditor";
import { PublicationReview } from "./PublicationReview";
import { RunAutomationButton } from "./RunAutomationButton";
import { SkillDetails } from "./SkillDetails";
import { SocialEditor } from "./SocialEditor";
import { SocialLibrary } from "./SocialLibrary";
import { SocialReview } from "./SocialReview";
import { TaskEditor } from "./TaskEditor";
import { TaskExecution } from "./TaskExecution";
import { TaskRunDialog } from "./TaskRunDialog";

function UploadHarness({ onBusy }: { readonly onBusy: (busy: boolean) => void }) {
    const [files, setFiles] = useState<MiraAttachment[]>([]);
    return <AttachmentPicker value={files} onChange={setFiles} onBusyChange={onBusy} />;
}

function fixture(content: ReactNode, enabled = false, supplied?: QueryClient) {
    const query =
        supplied ??
        new QueryClient({
            defaultOptions: { queries: { enabled, retry: false } },
        });
    const identity = new IdentityClient();
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>{content}</IdentityClientContext>
        </QueryClientProvider>
    );
    return () => {
        view.unmount();
        identity.cancelActions();
        query.clear();
    };
}

test("attachment retries reuse their identity and retain files accepted before a network failure", async () => {
    const requested: string[] = [];
    const busy: boolean[] = [];
    let attempts = 0;
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                const headers = new Headers(init?.headers);
                requested.push(headers.get("x-file-id") ?? "");
                attempts++;
                if (attempts === 2)
                    return Promise.reject(
                        new Error("Synthetic network loss after acceptance")
                    );
                return Promise.resolve(
                    Response.json({
                        id: headers.get("x-file-id"),
                        name: decodeURIComponent(headers.get("x-file-name") ?? ""),
                        mediaType: "text/plain; charset=utf-8",
                        bytes: 9,
                        createdAt: new Date().toISOString(),
                    })
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(<UploadHarness onBusy={(value) => busy.push(value)} />);
    try {
        const user = userEvent.setup();
        await user.upload(screen.getByLabelText("Attach files"), [
            new File(["Synthetic"], "one.txt", { type: "text/plain" }),
            new File(["Synthetic"], "two.txt", { type: "text/plain" }),
        ]);
        expect(await screen.findByText("one.txt")).toBeInTheDocument();
        await user.click(await screen.findByRole("button", { name: "Retry upload" }));
        expect(await screen.findByText("two.txt")).toBeInTheDocument();
        expect(screen.getByText("one.txt")).toBeInTheDocument();
        expect(requested).toHaveLength(3);
        expect(requested[1]).toBe(requested[2]);
        expect(requested[0]).not.toBe(requested[1]);
        await waitFor(() => expect(busy).toEqual([true, false, true, false]));
        await user.click(
            screen.getByRole("button", { name: "Remove one.txt from message" })
        );
        expect(screen.queryByText("one.txt")).not.toBeInTheDocument();
        expect(screen.getByText("two.txt")).toBeInTheDocument();
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test.each(["interrupted", "failed"] as const)(
    "partial %s replies remain readable with their actual outcome",
    (state) => {
        const cleanup = fixture(
            <ChatMessage
                message={{
                    id: crypto.randomUUID(),
                    role: "assistant",
                    content: "Partial verified observation",
                    state,
                    attachmentIds: [],
                    createdAt: new Date().toISOString(),
                }}
            />
        );
        try {
            expect(screen.getByText("Partial verified observation")).toBeInTheDocument();
            expect(screen.getByText(state)).toBeInTheDocument();
            expect(screen.queryByText("Mira is working…")).not.toBeInTheDocument();
        } finally {
            cleanup();
        }
    }
);

test("automation editor preserves delivery policy and exposes event and one-time schedules", async () => {
    const cleanup = fixture(<AutomationEditor onClose={() => {}} />);
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Schedule type" }));
        await user.click(screen.getByRole("option", { name: "Event" }));
        expect(screen.getByRole("button", { name: "Trigger event" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Trigger event" }));
        expect(
            screen.queryByRole("option", { name: "AgentMail message" })
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole("option", { name: "Task due" }));
        await user.click(screen.getByRole("button", { name: "Report notifications" }));
        await user.click(screen.getByRole("option", { name: "Silent" }));
        expect(
            screen.getByRole("button", { name: "Report notifications" })
        ).toHaveTextContent("Silent");
        await user.click(screen.getByRole("button", { name: "Schedule type" }));
        await user.click(screen.getByRole("option", { name: "Once" }));
        expect(
            screen.queryByRole("button", { name: "Trigger event" })
        ).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Save automation" })).toBeDisabled();
    } finally {
        cleanup();
    }
});

test("automation editor uses current Synthetic aliases and resets unsupported thinking and speed", async () => {
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const models = [
        v.parse(miraModelSchema, {
            model: "native-fixture",
            isDefault: true,
            supportedReasoningEfforts: [
                { reasoningEffort: "high", description: "Native high" },
            ],
        }),
        v.parse(miraModelSchema, {
            model: "syn:large:text",
            isDefault: false,
            description:
                "Currently Fixture A. Synthetic updates this alias automatically.",
            supportedReasoningEfforts: [
                { reasoningEffort: "max", description: "Current alias capability" },
            ],
        }),
        v.parse(miraModelSchema, { model: "syn:small:text", isDefault: false }),
    ];
    query.setQueryData(["operations", "mira", "models"], {
        models,
        defaultModel: "native-fixture",
        fresh: true,
    });
    const cleanup = fixture(<AutomationEditor onClose={() => {}} />, false, query);
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /Model provider/ }));
        await user.click(screen.getByRole("option", { name: "Synthetic subscription" }));
        expect(
            screen.getByRole("button", { name: /Automation model/ })
        ).toHaveTextContent("syn:large:text");
        expect(screen.getByText(/Currently Fixture A/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /Thinking level/ }));
        expect(screen.queryByRole("option", { name: "High" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("option", { name: "Max" }));
        await user.click(screen.getByRole("button", { name: /Automation model/ }));
        await user.click(screen.getByRole("option", { name: "syn:small:text" }));
        expect(screen.getByRole("button", { name: /Thinking level/ })).toHaveTextContent(
            "Default"
        );
        expect(screen.getByRole("button", { name: /Response speed/ })).toHaveTextContent(
            "Standard"
        );
        expect(
            screen.queryByRole("option", { name: "Fixture A" })
        ).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test.each(["configured-native", "syn:large:text"])(
    "returning to ChatGPT follows its deployment default (%s)",
    async (defaultModel) => {
        const choices: unknown[] = [];
        const cleanup = fixture(
            <ModelSettings
                draft={{ model: "syn:large:text", effort: "high", serviceTier: null }}
                setDraft={(value) => {
                    choices.push(value);
                }}
                models={[
                    v.parse(miraModelSchema, {
                        model: "catalog-native",
                        isDefault: true,
                    }),
                    v.parse(miraModelSchema, {
                        model: "configured-native",
                        isDefault: false,
                    }),
                    v.parse(miraModelSchema, {
                        model: "syn:large:text",
                        isDefault: false,
                    }),
                ]}
                defaultModel={defaultModel}
                fresh
            />
        );
        try {
            const user = userEvent.setup();
            await user.click(screen.getByRole("button", { name: /Model provider/ }));
            await user.click(
                screen.getByRole("option", { name: "ChatGPT subscription" })
            );
            expect(choices).toEqual([
                {
                    model: defaultModel === "configured-native" ? null : "catalog-native",
                    effort: null,
                    serviceTier: null,
                },
            ]);
        } finally {
            cleanup();
        }
    }
);

test.each([false, true])(
    "chat keyboard submission respects an active upload (%s)",
    (uploading) => {
        let submissions = 0;
        const cleanup = fixture(
            <ChatComposer
                text="Review the plan"
                onText={() => {}}
                attachments={[]}
                onAttachments={() => {}}
                uploading={uploading}
                onUploading={() => {}}
                sending={false}
                active={false}
                stopping={false}
                stopPending={false}
                onStop={() => {}}
                onSend={() => {
                    submissions++;
                }}
                onBrowse={() => {}}
            />
        );
        try {
            const input = screen.getByRole("textbox", { name: "Message Mira" });
            fireEvent.keyDown(input, { key: "Enter" });
            expect(submissions).toBe(0);
            fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
            expect(submissions).toBe(0);
            fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
            expect(submissions).toBe(uploading ? 0 : 1);
            if (uploading)
                expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
        } finally {
            cleanup();
        }
    }
);

test("chat model selection replaces unsupported thinking and speed choices", async () => {
    const models = [
        v.parse(miraModelSchema, {
            model: "synthetic-a",
            displayName: "Model A",
            isDefault: true,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
                { reasoningEffort: "low", description: "Quick" },
                { reasoningEffort: "high", description: "Deeper" },
            ],
            serviceTiers: [
                { id: "priority", name: "Fast", description: "Increased usage" },
            ],
        }),
        v.parse(miraModelSchema, {
            model: "synthetic-b",
            displayName: "Model B",
            isDefault: false,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Balanced" },
            ],
        }),
    ];
    const cleanup = fixture(
        <ChatSettings
            id={crypto.randomUUID()}
            version={1}
            settings={{
                ...miraDefaultChatSettings,
                model: "synthetic-a",
                effort: "high",
                serviceTier: "priority",
            }}
            models={models}
            defaultModel="synthetic-a"
            fresh
            display={{
                showActivity: true,
                keepActivity: false,
                showTools: true,
                expandTools: false,
            }}
            onDisplayChange={() => {}}
            onClose={() => {}}
        />
    );
    try {
        const user = userEvent.setup();
        expect(screen.getByText("Increased usage")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /Chat model/ }));
        await user.click(screen.getByRole("option", { name: "Model B" }));
        expect(screen.getByRole("button", { name: /Thinking level/ })).toHaveTextContent(
            "Default (medium)"
        );
        expect(screen.getByRole("button", { name: /Response speed/ })).toHaveTextContent(
            "Standard"
        );
        await user.click(screen.getByRole("button", { name: /Thinking level/ }));
        expect(screen.queryByRole("option", { name: "High" })).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test("chat activity shows provider thinking and safe recorded tool outcomes", () => {
    const cleanup = fixture(
        <ChatActivity
            run={{
                id: crypto.randomUUID(),
                conversationId: crypto.randomUUID(),
                taskId: null,
                automationId: null,
                state: "running",
                cancelRequested: false,
                message: null,
                createdAt: new Date().toISOString(),
                startedAt: null,
                finishedAt: null,
                activity: { phase: "thinking", tool: null },
            }}
            tools={[
                {
                    id: "synthetic",
                    tool: "mira_tasks_list",
                    state: "succeeded",
                    message: null,
                },
            ]}
            display={{
                showActivity: true,
                keepActivity: false,
                showTools: true,
                expandTools: true,
            }}
        />
    );
    try {
        expect(screen.getByRole("status")).toHaveTextContent("Thinking");
        expect(screen.getByText("tasks list")).toBeInTheDocument();
        expect(screen.getByText("Completed")).toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test("Run now retries an uncertain response with its original request identity", async () => {
    const requested: string[] = [];
    const started: string[] = [];
    const conversationId = crypto.randomUUID();
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected a synthetic JSON request body");
                const body = JSON.parse(init.body) as {
                    "0": { json: { requestId: string } };
                };
                requested.push(body["0"].json.requestId);
                if (requested.length === 1)
                    return Promise.reject(
                        new Error("Synthetic response lost after acceptance")
                    );
                return Promise.resolve(
                    Response.json([
                        {
                            result: {
                                data: serialize({
                                    id: crypto.randomUUID(),
                                    conversationId,
                                }),
                            },
                        },
                    ])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <RunAutomationButton
            id={crypto.randomUUID()}
            onStarted={(id) => started.push(id)}
        />
    );
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Run now" }));
        await waitFor(() => expect(requested).toHaveLength(1));
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled()
        );
        await user.click(screen.getByRole("button", { name: "Run now" }));
        await waitFor(() => expect(started).toHaveLength(1));
        expect(requested[1]).toBe(requested[0]);
        await user.click(screen.getByRole("button", { name: "Run now" }));
        await waitFor(() => expect(started).toHaveLength(2));
        expect(requested[2]).not.toBe(requested[1]);
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("task continuation retries the same frozen request", async () => {
    const requested: {
        requestId: string;
        instructions: string;
        reviewedRunId: string;
    }[] = [];
    const started: string[] = [];
    const conversationId = crypto.randomUUID();
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected a synthetic JSON request");
                const body = JSON.parse(init.body) as {
                    "0": { json: (typeof requested)[number] };
                };
                requested.push(body["0"].json);
                if (requested.length === 1)
                    return Promise.reject(new Error("Synthetic response lost"));
                return Promise.resolve(
                    Response.json([
                        {
                            result: {
                                data: serialize({
                                    id: crypto.randomUUID(),
                                    conversationId,
                                }),
                            },
                        },
                    ])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <TaskRunDialog
            id={crypto.randomUUID()}
            title="Synthetic task"
            version={2}
            reviewRunId={null}
            onClose={() => {}}
            onStarted={(id) => started.push(id)}
        />
    );
    try {
        const user = userEvent.setup();
        await user.type(
            screen.getByRole("textbox", { name: "Additional instructions" }),
            "Reconcile the recorded outcome first."
        );

        await user.click(screen.getByRole("button", { name: "Start work" }));
        await waitFor(() => expect(requested).toHaveLength(1));
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Start work" })).toBeEnabled()
        );
        expect(
            screen.getByRole("textbox", { name: "Additional instructions" })
        ).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "Start work" }));
        await waitFor(() => expect(started).toEqual([conversationId]));
        expect(requested[1]).toEqual(requested[0]);
        expect(requested[1]).toMatchObject({
            reviewedRunId: null,
            instructions: "Reconcile the recorded outcome first.",
        });
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("proposed changes display exact passive fields and retain their approval identity after response loss", async () => {
    const requested: unknown[] = [];
    let closed = 0;
    const proposal = {
        id: crypto.randomUUID(),
        tool: "mira_memory_create",
        inputHash: "a".repeat(64),
        input: {
            title: "Suggested preference",
            content: "<script>untrusted instruction</script>",
        },
        createdAt: new Date().toISOString(),
    };
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected JSON request");
                const body = JSON.parse(init.body) as { "0": { json: unknown } };
                requested.push(body["0"].json);
                if (requested.length === 1)
                    return Promise.reject(new Error("Synthetic lost response"));
                return Promise.resolve(
                    Response.json([
                        { result: { data: serialize({ state: "approved" }) } },
                    ])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <ProposalReview
            proposal={proposal}
            onClose={() => {
                closed++;
            }}
        />
    );
    try {
        const user = userEvent.setup();
        expect(screen.getByText(proposal.input.content)).toBeInTheDocument();
        expect(document.querySelector("script")).toBeNull();
        await user.click(screen.getByRole("button", { name: "Approve change" }));
        await waitFor(() => expect(requested).toHaveLength(1));
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Approve change" })).toBeEnabled()
        );
        expect(closed).toBe(0);
        await user.click(screen.getByRole("button", { name: "Approve change" }));
        await waitFor(() => expect(closed).toBe(1));
        expect(requested).toEqual([
            { id: proposal.id, inputHash: proposal.inputHash, approve: true },
            { id: proposal.id, inputHash: proposal.inputHash, approve: true },
        ]);
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("run history opens the selected old result and shows its uncertain tool receipt", async () => {
    // Happy DOM has no layout; virtualized rows need a non-zero synthetic viewport.
    const dimensions = ["clientHeight", "clientWidth"].map((name) => ({
        name,
        descriptor: Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
    }));
    Object.defineProperties(HTMLElement.prototype, {
        clientHeight: { value: 520, configurable: true },
        clientWidth: { value: 960, configurable: true },
    });

    const run = {
        id: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        automationId: null,
        taskId: null,
        state: "needs_attention" as const,
        cancelRequested: false,
        message: "An earlier tool needs review",
        title: "Earlier run",
        automationName: null,
        conversationAvailable: false,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
    };
    const requested: string[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (input: Parameters<typeof fetch>[0]) => {
                requested.push(input instanceof Request ? input.url : input.toString());
                return Promise.resolve(
                    Response.json([
                        {
                            result: {
                                data: serialize({
                                    run,
                                    rows: [
                                        {
                                            id: crypto.randomUUID(),
                                            tool: "mira_report_create",
                                            state: "unknown",
                                            message:
                                                "Verify the original outcome before repeating.",
                                            createdAt: run.createdAt,
                                            finishedAt: null,
                                        },
                                    ],
                                    nextCursor: null,
                                }),
                            },
                        },
                    ])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <MiraRunTable
            rows={[run]}
            onStop={() => {}}
            stoppingId={undefined}
            continuation={{ hasMore: false, loading: false, onLoadMore: () => {} }}
        />,
        true
    );
    try {
        await userEvent
            .setup()
            .click(await screen.findByRole("button", { name: "Details" }));
        expect(
            await screen.findByRole("dialog", { name: "Run details" })
        ).toBeInTheDocument();
        expect(
            await screen.findByText("Verify the original outcome before repeating.")
        ).toBeInTheDocument();
        expect(screen.getByText("Needs review")).toBeInTheDocument();
        expect(requested.some((url) => decodeURIComponent(url).includes(run.id))).toBe(
            true
        );
        await userEvent.setup().click(screen.getByRole("button", { name: "Close" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    } finally {
        cleanup();
        request.mockRestore();
        for (const { name, descriptor } of dimensions) {
            if (descriptor)
                Object.defineProperty(HTMLElement.prototype, name, descriptor);
            else Reflect.deleteProperty(HTMLElement.prototype, name);
        }
    }
});

test("email review displays every destination and retries only the same approved snapshot", async () => {
    const draft: MiraMailDraft = {
        id: crypto.randomUUID(),
        inboxId: "mira@example.com",
        version: 3,
        state: "draft",
        contentHash: "a".repeat(64),
        conversationId: null,
        message: null,
        providerMessageId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        content: {
            to: ["to@example.com"],
            cc: ["cc@example.com"],
            bcc: ["hidden@example.com"],
            subject: "Synthetic approval",
            text: "<img src=x onerror=alert(1)>\nExact plain text",
            attachments: [
                {
                    id: "11111111-1111-4111-8111-111111111111",
                    name: "Reviewed report.txt",
                    mediaType: "application/pdf",
                    bytes: 1024,
                    sha256: "b".repeat(64),
                },
            ],
        },
    };
    const requested: unknown[] = [];
    let closed = 0;
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected serialized approval");
                const body = JSON.parse(init.body) as { "0": { json: unknown } };
                requested.push(body["0"].json);
                if (requested.length === 1)
                    return Promise.reject(new Error("Synthetic lost acknowledgement"));
                return Promise.resolve(
                    Response.json([
                        { result: { data: serialize({ ...draft, state: "queued" }) } },
                    ])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <MailReview
            draft={draft}
            onClose={() => {
                closed++;
            }}
        />
    );
    try {
        for (const address of [
            draft.inboxId,
            ...draft.content.to,
            ...draft.content.cc,
            ...draft.content.bcc,
        ])
            expect(screen.getByText(address)).toBeInTheDocument();
        expect(screen.getByText(/Exact plain text/)).toBeInTheDocument();
        expect(screen.getByText(/Reviewed report.txt/)).toBeInTheDocument();
        expect(screen.getByText(/application\/pdf/)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
            "href",
            "/api/mira/files/11111111-1111-4111-8111-111111111111"
        );
        expect(screen.getByText(/Sent via AgentMail/)).toBeInTheDocument();
        expect(document.querySelector("img")).toBeNull();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Confirm and send" }));
        await waitFor(() => expect(requested).toHaveLength(1));
        expect(closed).toBe(0);
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Confirm and send" })).toBeEnabled()
        );
        await user.click(screen.getByRole("button", { name: "Confirm and send" }));
        await waitFor(() => expect(closed).toBe(1));
        expect(requested).toEqual(
            Array.from({ length: 2 }, () => ({
                id: draft.id,
                version: 3,
                contentHash: draft.contentHash,
                reviewedReply: draft.content.reply ?? null,
                reviewedAttachments: draft.content.attachments,
            }))
        );
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("email editor returns from file selection with its content intact and removes chosen attachments", async () => {
    const file: MiraAttachment = {
        id: crypto.randomUUID(),
        name: "Choose me.txt",
        mediaType: "text/plain",
        bytes: 1024,
        createdAt: new Date().toISOString(),
    };
    const requests: unknown[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url.includes("files.list"))
                    return Promise.resolve(
                        Response.json([
                            {
                                result: {
                                    data: serialize({ rows: [file], nextCursor: null }),
                                },
                            },
                        ])
                    );
                if (typeof init?.body !== "string")
                    throw new Error("Expected draft save");
                const body = JSON.parse(init.body) as { "0": { json: unknown } };
                requests.push(body["0"].json);
                return Promise.resolve(
                    Response.json([{ result: { data: serialize({}) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(<MailEditor onClose={() => {}} />, true);
    try {
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("To"), "recipient@example.com");
        await user.type(screen.getByLabelText("Subject"), "Preserved subject");
        await user.type(screen.getByLabelText("Message"), "Preserved body");
        await user.click(screen.getByRole("button", { name: "Choose file" }));
        await user.click(
            await screen.findByRole("button", { name: "Actions for Choose me.txt" })
        );
        await user.click(screen.getByRole("menuitem", { name: "Attach" }));
        expect(screen.getByLabelText("Subject")).toHaveValue("Preserved subject");
        expect(screen.getByText(file.name)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: `Remove ${file.name}` }));
        expect(screen.queryByText(file.name)).toBeNull();
        await user.click(screen.getByRole("button", { name: "Save draft" }));
        await waitFor(() => expect(requests).toHaveLength(1));
        expect(requests[0]).toMatchObject({
            content: {
                subject: "Preserved subject",
                text: "Preserved body",
                attachmentIds: [],
            },
        });
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("task recovery inspects the exact run and acknowledges it without starting work", async () => {
    const runId = crypto.randomUUID(),
        taskId = crypto.randomUUID();
    const requested: unknown[] = [];
    let closed = 0;
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (
                    (input instanceof Request ? input.url : input.toString()).includes(
                        "mira.runs.read"
                    )
                )
                    return Promise.resolve(
                        Response.json([
                            {
                                result: {
                                    data: serialize({
                                        run: {
                                            id: runId,
                                            title: "Uncertain task action",
                                            createdAt: new Date().toISOString(),
                                            state: "needs_attention",
                                            message: "Provider result unknown",
                                        },
                                        rows: [],
                                        nextCursor: null,
                                    }),
                                },
                            },
                        ])
                    );
                if (
                    !(input instanceof Request ? input.url : input.toString()).includes(
                        "mira.tasks.reviewRun"
                    ) ||
                    typeof init?.body !== "string"
                )
                    throw new Error("Unexpected request; review must not start work");
                requested.push(JSON.parse(init.body));
                if (requested.length === 1)
                    return Promise.reject(new Error("Synthetic response lost"));
                return Promise.resolve(
                    Response.json([{ result: { data: serialize(undefined) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <TaskRunDialog
            id={taskId}
            title="Task"
            version={3}
            reviewRunId={runId}
            onClose={() => closed++}
            onStarted={() => {
                throw new Error("Review started work");
            }}
        />,
        true
    );
    try {
        const user = userEvent.setup();
        const confirm = await screen.findByRole("button", { name: "Mark reviewed" });
        expect(confirm).toBeDisabled();
        expect(screen.getByText("Provider result unknown")).toBeInTheDocument();
        await user.click(
            screen.getByRole("switch", { name: "I have reviewed this uncertain outcome" })
        );
        await user.click(confirm);
        await waitFor(() => expect(requested).toHaveLength(1));
        await waitFor(() => expect(confirm).toBeEnabled());
        await user.click(confirm);
        await waitFor(() => expect(closed).toBe(1));
        expect(requested[1]).toEqual(requested[0]);
        expect(requested[0]).toEqual({
            "0": { json: { id: taskId, version: 3, runId } },
        });
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test.each([true, false])(
    "task outcome review remains available independently of start eligibility (%s)",
    async (hasReview) => {
        const runId = crypto.randomUUID();
        const request = spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(
                () =>
                    Promise.resolve(
                        Response.json([
                            {
                                result: {
                                    data: serialize({
                                        rows: [],
                                        nextCursor: null,
                                        version: 4,
                                        reviewRunId: hasReview ? runId : null,
                                    }),
                                },
                            },
                        ])
                    ),
                { preconnect: fetch.preconnect }
            )
        );
        const starts: unknown[] = [];
        const cleanup = fixture(
            <TaskExecution
                id={crypto.randomUUID()}
                canStart={false}
                onStart={(version, reviewed) => starts.push({ version, reviewed })}
            />,
            true
        );
        try {
            if (hasReview) {
                const review = await screen.findByRole("button", {
                    name: "Review uncertain run",
                });
                await userEvent.setup().click(review);
                expect(starts).toEqual([{ version: 4, reviewed: runId }]);
            } else {
                await screen.findByText(
                    "Assign an unfinished task to Mira to start work."
                );
                expect(
                    screen.queryByRole("button", {
                        name: /Start work|Continue work|Review uncertain run/,
                    })
                ).toBeNull();
            }
        } finally {
            cleanup();
            request.mockRestore();
        }
    }
);

test("reply editing preserves the subject and review shows the original thread and sender", () => {
    const draft: MiraMailDraft = {
        id: crypto.randomUUID(),
        inboxId: "mira@example.test",
        version: 1,
        state: "draft",
        contentHash: "a".repeat(64),
        conversationId: null,
        message: null,
        providerMessageId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        content: {
            to: ["recipient@example.test"],
            cc: [],
            bcc: [],
            subject: "Original subject",
            text: "Reply text",
            reply: {
                messageId: "original-message",
                threadId: "original-thread",
                from: "Original sender <sender@example.test>",
                subject: "Full original thread subject",
            },
        },
    };
    let cleanup = fixture(<MailEditor draft={draft} onClose={() => {}} />);
    try {
        expect(screen.getByLabelText("Subject")).toHaveAttribute("readonly");
        expect(
            screen.getByText("Replies keep the original email thread and subject.")
        ).toBeInTheDocument();
        cleanup();
        cleanup = fixture(<MailReview draft={draft} onClose={() => {}} />);
        expect(screen.getByText("Full original thread subject")).toBeInTheDocument();
        expect(
            screen.getByText("Original sender <sender@example.test>")
        ).toBeInTheDocument();
        expect(screen.getByText("recipient@example.test")).toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test("the AgentMail adapter makes its event trigger available in the automation editor", async () => {
    const cleanup = fixture(<AutomationEditor agentMailAvailable onClose={() => {}} />);
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Schedule type" }));
        await user.click(screen.getByRole("option", { name: "Event" }));
        await user.click(screen.getByRole("button", { name: "Trigger event" }));
        expect(
            screen.getByRole("option", { name: "AgentMail message" })
        ).toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test("existing task edits submit only writable fields accepted by the public schema", async () => {
    const task = {
        id: crypto.randomUUID(),
        version: 3,
        title: "Existing task",
        description: "Retain this",
        status: "todo" as const,
        assignee: "mira" as const,
        priority: "normal" as const,
        labels: ["existing"],
        dueAt: null,
        completionCriteria: "Verified",
        conversationId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    const submitted: unknown[] = [];
    let closed = false;
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected request body");
                const body = JSON.parse(init.body) as { "0": { json: unknown } };
                submitted.push(v.parse(miraTaskUpdateSchema, body["0"].json));
                return Promise.resolve(
                    Response.json([
                        {
                            result: {
                                data: serialize({
                                    ...task,
                                    title: "Updated task",
                                    version: 4,
                                }),
                            },
                        },
                    ])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <TaskEditor
            task={task}
            onClose={() => {
                closed = true;
            }}
        />
    );
    try {
        const user = userEvent.setup();
        await user.clear(screen.getByRole("textbox", { name: "Title" }));
        await user.type(screen.getByRole("textbox", { name: "Title" }), "Updated task");
        expect(screen.getByRole("button", { name: /Task start mode/ })).toHaveTextContent(
            "Run manually"
        );
        await user.click(screen.getByRole("button", { name: /Task start mode/ }));
        await user.click(screen.getByRole("option", { name: "Start automatically" }));
        await user.click(screen.getByRole("button", { name: "Save task" }));
        await waitFor(() => expect(closed).toBe(true));
        expect(submitted).toHaveLength(1);
        expect(submitted[0]).toMatchObject({
            id: task.id,
            version: 3,
            title: "Updated task",
            autoStart: true,
            description: "Retain this",
            labels: ["existing"],
        });
        expect(submitted[0]).not.toHaveProperty("createdAt");
        expect(submitted[0]).not.toHaveProperty("updatedAt");
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("publication review shows public visibility and files and retries only the exact displayed approval", async () => {
    const draft: MiraPublication = {
        id: crypto.randomUUID(),
        accountId: "synthetic",
        version: 2,
        state: "draft",
        contentHash: "a".repeat(64),
        conversationId: null,
        phase: null,
        slug: null,
        providerVersionId: null,
        message: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        content: {
            title: "Reviewed publication",
            target: { slug: "owned-site", baseVersionId: "reviewed-version" },
            visibility: "anyone_with_link",
            files: [
                {
                    id: crypto.randomUUID(),
                    name: "Reviewed page.html",
                    path: "index.html",
                    mediaType: "text/html",
                    bytes: 20,
                    sha256: "b".repeat(64),
                },
            ],
        },
    };
    const requested: unknown[] = [];
    let closed = 0;
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected approval body");
                const body = JSON.parse(init.body) as { "0": { json: unknown } };
                requested.push(body["0"].json);
                return requested.length === 1
                    ? Promise.reject(new Error("Synthetic response loss"))
                    : Promise.resolve(
                          Response.json([{ result: { data: serialize(draft) } }])
                      );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <PublicationReview
            draft={draft}
            onClose={() => {
                closed++;
            }}
        />
    );
    try {
        expect(
            screen.getByText(/replaces all existing files on owned-site/)
        ).toBeInTheDocument();
        expect(
            screen.getByText(/Anyone with the link can view every file/)
        ).toBeInTheDocument();
        expect(screen.getByText("index.html")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
            "href",
            `/api/mira/files/${draft.content.files[0]!.id}`
        );
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Publish publicly" }));
        await waitFor(() => expect(requested).toHaveLength(1));
        expect(closed).toBe(0);
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Publish publicly" })).toBeEnabled()
        );
        await user.click(screen.getByRole("button", { name: "Publish publicly" }));
        await waitFor(() => expect(closed).toBe(1));
        expect(requested).toEqual(
            Array.from({ length: 2 }, () => ({
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
                reviewedContent: draft.content,
            }))
        );
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("publication editor preserves title and selected site path through the shared file picker", async () => {
    const file: MiraAttachment = {
        id: crypto.randomUUID(),
        name: "Selected page.html",
        mediaType: "text/plain; charset=utf-8",
        bytes: 100,
        createdAt: new Date().toISOString(),
    };
    const requested: unknown[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                const url = input instanceof Request ? input.url : String(input);
                if (url.includes("files.list"))
                    return Promise.resolve(
                        Response.json([
                            {
                                result: {
                                    data: serialize({ rows: [file], nextCursor: null }),
                                },
                            },
                        ])
                    );
                if (typeof init?.body !== "string")
                    throw new Error("Expected draft body");
                const body = JSON.parse(init.body) as { "0": { json: unknown } };
                requested.push(body["0"].json);
                return Promise.resolve(
                    Response.json([{ result: { data: serialize({}) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(<PublicationEditor onClose={() => {}} />, true);
    try {
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Title"), "Preserved publication");
        await user.click(screen.getByRole("button", { name: "Choose file" }));
        await user.click(
            await screen.findByRole("button", { name: `Actions for ${file.name}` })
        );
        await user.click(screen.getByRole("menuitem", { name: "Attach" }));
        expect(screen.getByLabelText("Title")).toHaveValue("Preserved publication");
        const input = screen.getByLabelText(`Published path for ${file.name}`);
        await user.clear(input);
        await user.type(input, "assets/index.html");
        await user.click(screen.getByRole("button", { name: "Save draft" }));
        await waitFor(() => expect(requested).toHaveLength(1));
        expect(requested[0]).toMatchObject({
            version: 0,
            conversationId: null,
            content: {
                title: "Preserved publication",
                target: null,
                visibility: "anyone_with_link",
                files: [{ id: file.id, path: "assets/index.html" }],
            },
        });
    } finally {
        cleanup();
        request.mockRestore();
    }
});

function socialDraft(state: MiraSocialDraft["state"] = "draft"): MiraSocialDraft {
    return {
        id: crypto.randomUUID(),
        agentName: "SyntheticMira",
        version: 3,
        state,
        content: {
            kind: "comment",
            postId: "reviewed-post",
            parentId: "reviewed-parent",
            text: "Exact reviewed reply\n<script>not executed</script>",
        },
        contentHash: "c".repeat(64),
        conversationId: null,
        providerId: state === "draft" ? null : "comment-1",
        challenge:
            state === "verification_required"
                ? "Untrusted challenge: <a href='https://example.invalid'>link</a>"
                : null,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        message: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}
test("Moltbook review submits exactly the displayed reply and renders external text passively", async () => {
    const draft = socialDraft();
    const requested: unknown[] = [];
    let closed = false;
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (typeof init?.body !== "string") throw new Error("Expected body");
                const body = JSON.parse(init.body) as { "0": { json: unknown } };
                requested.push(body["0"].json);
                return Promise.resolve(
                    Response.json([{ result: { data: serialize(draft) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <SocialReview
            draft={draft}
            onClose={() => {
                closed = true;
            }}
        />
    );
    try {
        expect(screen.getByText(/Posting as SyntheticMira/)).toHaveTextContent(
            "Parent comment: reviewed-parent"
        );
        expect(screen.getByText(/<script>not executed/)).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Send publicly" }));
        await waitFor(() => expect(closed).toBe(true));
        expect(requested).toEqual([
            {
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
                reviewedContent: draft.content,
            },
        ]);
    } finally {
        cleanup();
        request.mockRestore();
    }
});
test("Moltbook challenge submits only the selected draft version and operator answer", async () => {
    const draft = socialDraft("verification_required");
    const requested: unknown[] = [];
    let closed = false;
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (typeof init?.body !== "string") throw new Error("Expected body");
                const body = JSON.parse(init.body) as { "0": { json: unknown } };
                requested.push(body["0"].json);
                return Promise.resolve(
                    Response.json([{ result: { data: serialize(draft) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <SocialReview
            draft={draft}
            onClose={() => {
                closed = true;
            }}
        />
    );
    try {
        expect(
            screen.queryByRole("button", { name: "Send publicly" })
        ).not.toBeInTheDocument();
        expect(screen.queryByRole("link", { name: "link" })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Answer"), "15.00");
        await user.click(screen.getByRole("button", { name: "Submit answer" }));
        await waitFor(() => expect(closed).toBe(true));
        expect(requested).toEqual([
            { id: draft.id, version: draft.version, answer: "15.00" },
        ]);
    } finally {
        cleanup();
        request.mockRestore();
    }
});
test("Moltbook editor preserves the reply destination and saves without approval", async () => {
    const draft = socialDraft();
    const requested: unknown[] = [];
    let closed = false;
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (typeof init?.body !== "string") throw new Error("Expected body");
                const body = JSON.parse(init.body) as { "0": { json: unknown } };
                requested.push(body["0"].json);
                return Promise.resolve(
                    Response.json([{ result: { data: serialize(draft) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <SocialEditor
            draft={draft}
            onClose={() => {
                closed = true;
            }}
        />
    );
    try {
        expect(screen.getByLabelText("Post ID")).toHaveValue("reviewed-post");
        expect(screen.getByLabelText("Parent comment ID")).toHaveValue("reviewed-parent");
        const user = userEvent.setup();
        await user.clear(screen.getByLabelText("Text"));
        await user.type(screen.getByLabelText("Text"), "Edited reply");
        await user.click(screen.getByRole("button", { name: "Save draft" }));
        await waitFor(() => expect(closed).toBe(true));
        expect(requested).toEqual([
            {
                id: draft.id,
                version: draft.version,
                conversationId: null,
                content: {
                    kind: "comment",
                    postId: "reviewed-post",
                    parentId: "reviewed-parent",
                    text: "Edited reply",
                },
            },
        ]);
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("Moltbook library opens the selected review and returns to its owned drafts", async () => {
    const draft = socialDraft();
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            () =>
                Promise.resolve(
                    Response.json([
                        {
                            result: {
                                data: serialize({ rows: [draft], nextCursor: null }),
                            },
                        },
                    ])
                ),
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(<SocialLibrary onClose={() => {}} />, true);
    try {
        await screen.findByText("Comment or reply");
        const user = userEvent.setup();
        await user.click(
            screen.getByRole("button", { name: "Actions for Comment or reply" })
        );
        await user.click(screen.getByRole("menuitem", { name: "Review and send" }));
        expect(screen.getByRole("button", { name: "Send publicly" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Close" }));
        await user.click(screen.getByRole("button", { name: "New draft" }));
        expect(screen.getByLabelText("Community")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.getByRole("button", { name: "New draft" })).toBeInTheDocument();
    } finally {
        cleanup();
        request.mockRestore();
    }
});

function cloudJob(): MiraDaytonaJob {
    return {
        executionTarget: "daytona",
        id: "11111111-1111-4111-8111-111111111111",
        version: 1,
        content: {
            title: "Reviewed command",
            command: "echo '<script>passive</script>'",
            inputs: [],
            outputs: [],
        },
        contentHash: "a".repeat(64),
        conversationId: null,
        taskId: null,
        state: "draft",
        phase: "idle",
        cleanup: "not_needed",
        cancelRequested: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        output: "",
        files: [],
        message: null,
        createdAt: "2026-10-25T12:00:00Z",
        updatedAt: "2026-10-25T12:00:00Z",
    };
}
test.each(["main", "daytona"] as const)(
    "%s review submits the displayed target and command and closes after approval",
    async (executionTarget) => {
        const job = { ...cloudJob(), executionTarget };
        const requested: unknown[] = [];
        let closed = false;
        const request = spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(
                (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                    if (typeof init?.body !== "string") throw new Error("Expected body");
                    requested.push(
                        (JSON.parse(init.body) as { "0": { json: unknown } })["0"].json
                    );
                    return Promise.resolve(
                        Response.json([
                            { result: { data: serialize({ ...job, state: "queued" }) } },
                        ])
                    );
                },
                { preconnect: fetch.preconnect }
            )
        );
        const cleanup = fixture(
            <DaytonaDetails
                job={job}
                onClose={() => {
                    closed = true;
                }}
            />
        );
        try {
            expect(screen.getByText(job.content.command)).toBeInTheDocument();
            await userEvent.setup().click(
                screen.getByRole("button", {
                    name:
                        executionTarget === "main" ? "Start on Main" : "Start on Daytona",
                })
            );
            await waitFor(() => expect(closed).toBe(true));
            expect(requested).toEqual([
                {
                    id: job.id,
                    version: 1,
                    contentHash: job.contentHash,
                    reviewedContent: job.content,
                    executionTarget,
                },
            ]);
        } finally {
            cleanup();
            request.mockRestore();
        }
    }
);
test("cloud details keep command completion separate from pending cleanup and render logs passively", () => {
    const job = {
        ...cloudJob(),
        state: "running" as const,
        phase: "cleaning",
        cleanup: "pending" as const,
        exitCode: 0,
        stdout: "<img src=x onerror=alert(1)>",
        cancelRequested: true,
    };
    const cleanup = fixture(<DaytonaDetails job={job} onClose={() => {}} />);
    try {
        expect(screen.getByText("Pending")).toBeInTheDocument();
        expect(screen.getByText(job.stdout)).toBeInTheDocument();
        expect(screen.queryByRole("img")).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Start on Daytona" })
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Cancel job" })
        ).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});
test("cloud review does not silently replace the command when a newer draft arrives", async () => {
    const job = cloudJob();
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const cleanup = fixture(
        <DaytonaDetails job={job} onClose={() => {}} />,
        false,
        query
    );
    try {
        act(() => {
            query.setQueryData(["operations", "mira", "daytona", job.id], {
                ...job,
                version: 2,
                content: { ...job.content, command: "new unseen command" },
            });
        });
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Start on Daytona" })
            ).toBeDisabled()
        );
        expect(screen.getByText(job.content.command)).toBeInTheDocument();
        expect(screen.queryByText("new unseen command")).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});
test("cloud draft editor saves locally without approving or executing", async () => {
    const requested: unknown[] = [];
    let closed = false;
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (typeof init?.body !== "string") throw new Error("Expected body");
                requested.push(
                    (JSON.parse(init.body) as { "0": { json: unknown } })["0"].json
                );
                return Promise.resolve(
                    Response.json([{ result: { data: serialize(cloudJob()) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <DaytonaEditor
            onClose={() => {
                closed = true;
            }}
        />
    );
    try {
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Title"), "Build a report");
        await user.type(screen.getByLabelText("Command"), "bun --version");
        await user.type(screen.getByLabelText("Result filenames"), "report.json");
        await user.click(screen.getByRole("button", { name: "Save draft" }));
        await waitFor(() => expect(closed).toBe(true));
        expect(requested).toHaveLength(1);
        expect(requested[0]).toMatchObject({
            version: 0,
            content: {
                title: "Build a report",
                command: "bun --version",
                inputs: [],
                outputs: ["report.json"],
            },
        });
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("cloud history opens the selected draft and returns to its list without stacked dialogs", async () => {
    const job = cloudJob();
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    query.setQueryData(["operations", "mira", "daytona", undefined], {
        pages: [{ rows: [job], nextCursor: null }],
        pageParams: [undefined],
    });
    const cleanup = fixture(<DaytonaJobs onClose={() => {}} />, false, query);
    try {
        const user = userEvent.setup();
        expect(
            screen.getByRole("heading", { name: job.content.title })
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Review" }));
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        expect(
            screen.getByRole("button", { name: "Start on Daytona" })
        ).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Close" }));
        await user.click(screen.getByRole("button", { name: "Edit" }));
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        expect(screen.getByLabelText("Command")).toHaveValue(job.content.command);
    } finally {
        cleanup();
    }
});

test("cancelling a reviewed cloud draft closes its stale review dialog", async () => {
    const job = cloudJob();
    const requested: unknown[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (typeof init?.body === "string")
                    requested.push(
                        (JSON.parse(init.body) as { "0": { json: unknown } })["0"].json
                    );
                return Promise.resolve(
                    Response.json([
                        {
                            result: {
                                data: serialize({
                                    ...job,
                                    version: 2,
                                    state: "cancelled",
                                }),
                            },
                        },
                    ])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    let closed = false;
    const cleanup = fixture(
        <DaytonaDetails
            job={job}
            onClose={() => {
                closed = true;
            }}
        />
    );
    try {
        await userEvent.setup().click(screen.getByRole("button", { name: "Cancel job" }));
        await waitFor(() => expect(closed).toBe(true));
        expect(requested).toEqual([{ id: job.id, version: job.version }]);
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("finished cloud jobs needing attention do not offer cancellation", () => {
    const job: MiraDaytonaJob = {
        ...cloudJob(),
        state: "needs_attention",
        phase: "closed",
        cleanup: "confirmed",
        message: "Selected result missing",
    };
    const cleanup = fixture(<DaytonaDetails job={job} onClose={() => {}} />);
    try {
        expect(screen.getByText("Selected result missing")).toBeInTheDocument();
        expect(screen.getByText("Confirmed")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Cancel job" })
        ).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test("cleanup recovery requires explicit typed identity and evidence, and freezes that identity", async () => {
    const id = cloudJob().id;
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const key = ["operations", "mira", "daytona", "recovery", id];
    const recovery = {
        id,
        identityHash: "a".repeat(64),
        organizationId: "original-org",
        snapshotId: "original-snapshot",
        target: "eu",
        sandboxId: null,
        sandboxName: "mira-original",
        eligibleAt: null,
        blockedReason: null,
        resolution: null,
    };
    query.setQueryData(key, recovery);
    const identity = new IdentityClient();
    const content = () => (
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <DaytonaRecovery id={id} onClose={() => {}} />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    const view = render(content());
    try {
        const user = userEvent.setup();
        const confirm = screen.getByRole("button", { name: "Confirm external cleanup" });
        expect(confirm).toBeDisabled();
        fireEvent.change(screen.getByLabelText("Sandbox name confirmation"), {
            target: { value: "mira-original" },
        });
        fireEvent.change(screen.getByLabelText("Verification note"), {
            target: { value: "Verified removal in the original organization." },
        });
        await user.click(screen.getByRole("checkbox"));
        expect(confirm).toBeEnabled();
        act(() => {
            query.setQueryData(key, {
                ...recovery,
                identityHash: "b".repeat(64),
                sandboxId: "new-id",
            });
        });
        // Re-render the same component instance with the changed cache; do not depend
        // on React Query's deferred notification timer under the parallel DOM runner.
        view.rerender(content());
        expect(
            screen.getByRole("button", { name: "Confirm external cleanup" })
        ).toBeDisabled();
        expect(
            screen.getByText("The sandbox identity changed. Close and review it again.")
        ).toBeInTheDocument();
    } finally {
        view.unmount();
        identity.cancelActions();
        query.clear();
    }
});

test("operator cleanup is shown as a distinct record without cancel or approval actions", async () => {
    const id = cloudJob().id;
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    query.setQueryData(["operations", "mira", "daytona", "recovery", id], {
        id,
        identityHash: "a".repeat(64),
        organizationId: "original-org",
        snapshotId: "original-snapshot",
        target: "eu",
        sandboxId: null,
        sandboxName: "mira-original",
        eligibleAt: null,
        blockedReason: "Already resolved",
        resolution: {
            actor: "human:operator",
            reason: "Checked provider cleanup",
            at: "2026-10-25T13:00:00Z",
        },
    });
    const cleanup = fixture(
        <DaytonaDetails
            job={{
                ...cloudJob(),
                state: "needs_attention",
                phase: "closed",
                cleanup: "operator_confirmed",
            }}
            onClose={() => {}}
        />,
        false,
        query
    );
    try {
        expect(screen.getByText("Confirmed by operator")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Cancel job" })
        ).not.toBeInTheDocument();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "View cleanup record" }));
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        expect(screen.getByText("Checked provider cleanup")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Confirm external cleanup" })
        ).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

function codeDraft(state: MiraCodePublication["state"] = "draft"): MiraCodePublication {
    return {
        id: crypto.randomUUID(),
        version: 2,
        conversationId: null,
        state,
        content: {
            title: "fix(dashboard): reviewed change",
            body: "Exact PR description <script>passive</script>",
            checkId: crypto.randomUUID(),
            commit: "a".repeat(40),
            edits: { id: crypto.randomUUID(), sha256: "b".repeat(64) },
        },
        contentHash: "c".repeat(64),
        phase: null,
        branch: null,
        commit: null,
        number: null,
        observation: null,
        inspectionRequested: false,
        observedAt: null,
        message: null,
        createdAt: "2026-10-25T19:00:00Z",
        updatedAt: "2026-10-25T19:00:00Z",
    };
}
test("code review requires matching verified source and submits only the current exact proposal", async () => {
    const draft = codeDraft(),
        query = new QueryClient({
            defaultOptions: {
                queries: { enabled: false, retry: false, staleTime: Infinity },
            },
        });
    const plan = {
        version: 1,
        commit: draft.content.commit,
        files: [
            {
                path: "example.ts",
                beforeSha256: null,
                content: "<script>passive</script>",
            },
        ],
    };
    const key = ["operations", "mira", "code-source", draft.id, draft.contentHash];
    query.setQueryData(key, { contentHash: "wrong", plan });
    const requested: unknown[] = [];
    let closed = false;
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_target: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (typeof init?.body !== "string")
                    return Promise.resolve(
                        Response.json([
                            {
                                result: {
                                    data: serialize({
                                        contentHash: draft.contentHash,
                                        plan,
                                    }),
                                },
                            },
                        ])
                    );
                requested.push(
                    (JSON.parse(init.body) as { "0": { json: unknown } })["0"].json
                );
                return Promise.resolve(
                    Response.json([
                        { result: { data: serialize({ ...draft, state: "queued" }) } },
                    ])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const identity = new IdentityClient();
    const content = () => (
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <CodeReview
                    draft={draft}
                    onClose={() => {
                        closed = true;
                    }}
                />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    const view = render(content());
    try {
        expect(screen.getByRole("button", { name: "Create draft PR" })).toBeDisabled();
        expect(screen.getByText(draft.content.body)).toBeInTheDocument();
        expect(
            screen.getByRole("region", { name: "Changes to example.ts" })
        ).toHaveTextContent("<script>passive</script>");
        act(() => {
            query.setQueryData(key, { contentHash: draft.contentHash, plan });
        });
        // Render the same instance against the changed cache without depending on
        // React Query's deferred notification timer under the parallel DOM runner.
        view.rerender(content());
        expect(screen.getByRole("button", { name: "Create draft PR" })).toBeEnabled();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Create draft PR" }));
        await waitFor(() => expect(closed).toBe(true));
        expect(requested).toEqual([
            {
                id: draft.id,
                version: draft.version,
                contentHash: draft.contentHash,
                reviewedContent: draft.content,
            },
        ]);
    } finally {
        view.unmount();
        identity.cancelActions();
        query.clear();
        request.mockRestore();
    }
});
test("uncertain code publication offers inspection and a recovered PR link without any publish button", async () => {
    const draft = codeDraft("needs_attention");
    draft.observation = {
        branchSha: "d".repeat(40),
        pullRequest: {
            number: 123,
            url: "https://github.com/rajohan/homelab/pull/123",
            state: "open",
            draft: true,
            commit: "d".repeat(40),
            base: draft.content.commit,
        },
    };
    const requested: unknown[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_target: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected inspection mutation");
                requested.push(
                    (JSON.parse(init.body) as { "0": { json: unknown } })["0"].json
                );
                return Promise.resolve(
                    Response.json([{ result: { data: serialize(undefined) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(<CodeReview draft={draft} onClose={() => {}} />);
    try {
        expect(
            screen.queryByRole("button", { name: "Create draft PR" })
        ).not.toBeInTheDocument();
        expect(screen.getByRole("link", { name: "Open PR" })).toHaveAttribute(
            "href",
            "https://github.com/rajohan/homelab/pull/123"
        );
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Inspect GitHub" }));
        await waitFor(() => expect(requested).toHaveLength(1));
        expect(requested[0]).toEqual({ id: draft.id, version: draft.version });
    } finally {
        cleanup();
        request.mockRestore();
    }
});
test("code editor preserves PR text while choosing a successful check and saves only a local proposal", async () => {
    const job = {
        ...cloudJob(),
        state: "completed" as const,
        cleanup: "confirmed" as const,
        exitCode: 0,
    };
    job.content.command = `bun --no-env-file /opt/homelab/daytona-check.js ${job.id} ${"a".repeat(40)} --edits ${"b".repeat(64)}`;
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    query.setQueryData(["operations", "mira", "code-checks", undefined], {
        pages: [{ rows: [job, cloudJob()], nextCursor: null }],
        pageParams: [undefined],
    });
    const requested: unknown[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_target: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected draft body");
                requested.push(
                    (JSON.parse(init.body) as { "0": { json: unknown } })["0"].json
                );
                return Promise.resolve(
                    Response.json([{ result: { data: serialize({}) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(<CodeEditor onClose={() => {}} />, false, query);
    try {
        const user = userEvent.setup();
        expect(screen.getByRole("button", { name: "Save proposal" })).toBeDisabled();
        await user.type(screen.getByLabelText("PR title"), "fix: retained title");
        await user.type(screen.getByLabelText("Description"), "Retained body");
        await user.click(screen.getByRole("button", { name: "Choose check" }));
        expect(screen.getAllByRole("button", { name: "Choose check" })).toHaveLength(1);
        await user.click(screen.getByRole("button", { name: "Choose check" }));
        expect(screen.getByLabelText("PR title")).toHaveValue("fix: retained title");
        await user.click(screen.getByRole("button", { name: "Save proposal" }));
        await waitFor(() => expect(requested).toHaveLength(1));
        expect(requested[0]).toMatchObject({
            version: 0,
            conversationId: null,
            content: {
                checkId: job.id,
                commit: "a".repeat(40),
                title: "fix: retained title",
                body: "Retained body",
            },
        });
    } finally {
        cleanup();
        request.mockRestore();
    }
});
test("code history uses a bounded list and opens shared proposal review", async () => {
    const draft = codeDraft("published");
    draft.number = 123;
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    query.setQueryData(["operations", "mira", "code", undefined], {
        pages: [{ rows: [draft], nextCursor: null }],
        pageParams: [undefined],
    });
    const cleanup = fixture(<CodeLibrary />, false, query);
    try {
        expect(screen.getByRole("heading", { name: "Code changes" })).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(
            screen.getByRole("button", { name: `Actions for ${draft.content.title}` })
        );
        await user.click(screen.getByRole("menuitem", { name: "View proposal" }));
        expect(screen.getByRole("link", { name: "Open PR" })).toHaveAttribute(
            "href",
            "https://github.com/rajohan/homelab/pull/123"
        );
    } finally {
        cleanup();
    }
});

test("automatic coding permission displays its scope and sends the exact reviewed versions", async () => {
    const automation = {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Dashboard improvement",
        kind: "improvement" as const,
        prompt: "Inspect frontend work.",
        schedule: { kind: "interval" as const, intervalSeconds: 3600 },
        budgetSeconds: 900,
        delivery: "reports" as const,
        version: 4,
        nextRunAt: null,
    };
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    query.setQueryData(["operations", "mira", "improvement-grant", automation.id], {
        automationId: automation.id,
        version: 2,
        enabled: false,
        current: true,
        available: true,
    });
    const requested: unknown[] = [];
    let closed = 0;
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_target: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected permission mutation.");
                requested.push(
                    (JSON.parse(init.body) as { "0": { json: unknown } })["0"].json
                );
                return Promise.resolve(
                    Response.json([{ result: { data: serialize({}) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <ImprovementPermission
            automation={automation}
            onClose={() => {
                closed++;
            }}
        />,
        false,
        query
    );
    try {
        expect(screen.getByText(/credits or billing/)).toBeInTheDocument();
        expect(screen.getByText(/At most two attempts/)).toBeInTheDocument();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Allow code changes" }));
        await waitFor(() => expect(closed).toBe(1));
        expect(requested).toEqual([
            {
                automationId: automation.id,
                automationVersion: 4,
                version: 2,
                enabled: true,
                policyVersion: 2,
            },
        ]);
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("stale coding permission can be revoked while unavailable integrations prevent renewal", async () => {
    const automation = {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Dashboard improvement",
        kind: "improvement" as const,
        prompt: "Inspect frontend work.",
        schedule: { kind: "interval" as const, intervalSeconds: 3600 },
        budgetSeconds: 900,
        delivery: "reports" as const,
        version: 4,
        nextRunAt: null,
    };
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    query.setQueryData(["operations", "mira", "improvement-grant", automation.id], {
        automationId: automation.id,
        version: 2,
        enabled: true,
        current: false,
        available: false,
    });
    const requested: unknown[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_target: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected permission mutation.");
                requested.push(
                    (JSON.parse(init.body) as { "0": { json: unknown } })["0"].json
                );
                return Promise.resolve(
                    Response.json([{ result: { data: serialize({}) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <ImprovementPermission automation={automation} onClose={() => {}} />,
        false,
        query
    );
    try {
        expect(screen.getByRole("button", { name: "Renew permission" })).toBeDisabled();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Revoke permission" }));
        await waitFor(() => expect(requested).toHaveLength(1));
        expect(requested[0]).toMatchObject({ enabled: false, version: 2 });
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("blocked automatic attempt requires a review note and submits only its exact identity", async () => {
    const automation = {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Dashboard improvement",
        kind: "improvement" as const,
        prompt: "Inspect frontend work.",
        schedule: { kind: "interval" as const, intervalSeconds: 3600 },
        budgetSeconds: 900,
        delivery: "reports" as const,
        version: 4,
        nextRunAt: null,
    };
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    query.setQueryData(["operations", "mira", "improvement-grant", automation.id], {
        automationId: automation.id,
        version: 2,
        enabled: true,
        current: false,
        available: false,
        blocked: {
            id: "22222222-2222-4222-8222-222222222222",
            canClose: true,
            reason: "Review the existing attempt first.",
        },
    });
    const requested: unknown[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_target: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected permission mutation.");
                requested.push(
                    (JSON.parse(init.body) as { "0": { json: unknown } })["0"].json
                );
                return Promise.resolve(
                    Response.json([{ result: { data: serialize({}) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(
        <ImprovementPermission automation={automation} onClose={() => {}} />,
        false,
        query
    );
    try {
        const user = userEvent.setup();
        expect(
            screen.getByRole("button", { name: "Close reviewed attempt" })
        ).toBeDisabled();
        await user.type(
            screen.getByLabelText("Review note"),
            "Inspected the recorded GitHub outcome."
        );
        await user.click(screen.getByRole("button", { name: "Close reviewed attempt" }));
        await waitFor(() => expect(requested).toHaveLength(1));
        expect(requested[0]).toEqual({
            id: "22222222-2222-4222-8222-222222222222",
            reviewed: true,
            reason: "Inspected the recorded GitHub outcome.",
        });
    } finally {
        cleanup();
        request.mockRestore();
    }
});

function skillSummary(): MiraSkillSummary {
    return {
        id: "task-tracking",
        title: "Tasks and reports",
        description: "Reviewed task guidance.",
        version: "1.0.0",
        packageHash: "a".repeat(64),
        sources: ["https://github.com/rajohan/homelab/blob/synthetic/docs/mira-tasks.md"],
        tools: ["mira_tasks_list"],
        controls: [],
        repositoryContext: true,
        compatibility: "available",
        files: [{ path: "SKILL.md", sha256: "b".repeat(64), bytes: 23 }],
        control: {
            key: "skill:task-tracking",
            enabled: false,
            version: 7,
            reason: "Paused for review",
            until: "2026-11-01T09:00:00.000Z",
        },
    };
}

test("skill preview is available while paused and enabling sends the displayed control version", async () => {
    const skill = skillSummary();
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    query.setQueryData(["operations", "mira", "skills"], [skill]);
    query.setQueryData(
        ["operations", "mira", "skill", skill.id, skill.packageHash, "SKILL.md"],
        {
            id: skill.id,
            packageHash: skill.packageHash,
            version: "1.0.0",
            path: "SKILL.md",
            sha256: "b".repeat(64),
            content: "# Review task progress\nRead the exact task before acting.",
        }
    );
    const requested: unknown[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected mutation body");
                requested.push(
                    (JSON.parse(init.body) as { "0": { json: unknown } })["0"].json
                );
                return Promise.resolve(
                    Response.json([{ result: { data: serialize(undefined) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture(<MiraSkills />, false, query);
    try {
        const user = userEvent.setup();
        expect(screen.getByText(/Paused for review.*Resumes/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "View" }));
        expect(
            screen.getByRole("heading", { name: "Review task progress" })
        ).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "View source" })).toHaveAttribute(
            "href",
            skill.sources[0]
        );
        expect(requested).toHaveLength(0);
        await user.click(screen.getByRole("button", { name: "Close dialog" }));
        await user.click(screen.getByRole("button", { name: "Enable" }));
        await waitFor(() => expect(requested).toHaveLength(1));
        expect(requested[0]).toEqual({
            key: skill.control.key,
            enabled: true,
            version: 7,
            reason: null,
            until: null,
        });
        act(() => {
            query.setQueryData(
                ["operations", "mira", "skills"],
                [
                    {
                        ...skill,
                        control: {
                            ...skill.control,
                            enabled: true,
                            version: 8,
                            reason: null,
                            until: null,
                        },
                    },
                ]
            );
        });
        await user.click(await screen.findByRole("button", { name: "Pause" }));
        expect(
            screen.getByText(/Previously loaded guidance remains in conversations/)
        ).toBeInTheDocument();
        expect(
            screen.queryByText(/Queued automatic runs will be skipped/)
        ).not.toBeInTheDocument();
        await user.type(screen.getByLabelText("Reason"), "Review the new guidance first");
        await user.click(
            within(screen.getByRole("dialog")).getByRole("button", { name: "Pause" })
        );
        await waitFor(() => expect(requested).toHaveLength(2));
        expect(requested[1]).toEqual({
            key: skill.control.key,
            enabled: false,
            version: 8,
            reason: "Review the new guidance first",
            until: null,
        });
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("skill preview switches only among supplied companion files without enabling them", async () => {
    const skill = skillSummary();
    skill.files.push({
        path: "references/workflow.md",
        sha256: "c".repeat(64),
        bytes: 17,
    });
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    for (const file of skill.files)
        query.setQueryData(
            ["operations", "mira", "skill", skill.id, skill.packageHash, file.path],
            {
                id: skill.id,
                packageHash: skill.packageHash,
                version: skill.version,
                path: file.path,
                sha256: file.sha256,
                content:
                    file.path === "SKILL.md" ? "Main guidance" : "Companion workflow",
            }
        );
    const cleanup = fixture(
        <SkillDetails skill={skill} onClose={() => {}} />,
        false,
        query
    );
    try {
        const user = userEvent.setup();
        expect(screen.getByText("Main guidance")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Skill file" }));
        await user.click(screen.getByRole("option", { name: "references/workflow.md" }));
        expect(screen.getByText("Companion workflow")).toBeInTheDocument();
        expect(screen.queryByText("Main guidance")).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test.each(["offline", "update_required"] as const)(
    "skill preview remains available when executor compatibility is %s",
    async (compatibility) => {
        const skill = { ...skillSummary(), compatibility };
        const query = new QueryClient({
            defaultOptions: { queries: { enabled: false, retry: false } },
        });
        query.setQueryData(["operations", "mira", "skills"], [skill]);
        query.setQueryData(
            ["operations", "mira", "skill", skill.id, skill.packageHash, "SKILL.md"],
            { content: "Review the installed guidance." }
        );
        const cleanup = fixture(<MiraSkills />, false, query);
        try {
            expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
            await userEvent.setup().click(screen.getByRole("button", { name: "View" }));
            expect(
                screen.getByText("Review the installed guidance.")
            ).toBeInTheDocument();
        } finally {
            cleanup();
        }
    }
);

test("Main cleanup cannot be replaced by a cloud cleanup assertion", () => {
    const job: MiraDaytonaJob = {
        ...cloudJob(),
        executionTarget: "main",
        state: "needs_attention",
        cleanup: "pending",
        phase: "cleaning",
    };
    const cleanup = fixture(<DaytonaDetails job={job} onClose={() => {}} />);
    try {
        expect(screen.getByText("Main · local")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Resolve cleanup" })
        ).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});
