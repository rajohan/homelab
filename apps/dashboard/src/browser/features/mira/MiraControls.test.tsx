import { expect, spyOn, test } from "bun:test";

import {
    miraDefaultChatSettings,
    miraModelSchema,
    miraTaskUpdateSchema,
} from "@homelab/contracts/mira";
import type { MiraAttachment } from "@homelab/contracts/mira";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { MiraRunTable } from "./MiraRunTable";
import { ProposalReview } from "./ProposalReview";
import { RunAutomationButton } from "./RunAutomationButton";
import { TaskEditor } from "./TaskEditor";
import { TaskExecution } from "./TaskExecution";
import { TaskRunDialog } from "./TaskRunDialog";

function UploadHarness({ onBusy }: { readonly onBusy: (busy: boolean) => void }) {
    const [files, setFiles] = useState<MiraAttachment[]>([]);
    return <AttachmentPicker value={files} onChange={setFiles} onBusyChange={onBusy} />;
}

function fixture(content: ReactNode, enabled = false) {
    const query = new QueryClient({
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
        await user.click(screen.getByRole("button", { name: "Save task" }));
        await waitFor(() => expect(closed).toBe(true));
        expect(submitted).toHaveLength(1);
        expect(submitted[0]).toMatchObject({
            id: task.id,
            version: 3,
            title: "Updated task",
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
