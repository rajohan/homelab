import { expect, spyOn, test } from "bun:test";

import type { MiraProposal } from "@homelab/contracts/mira";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { serialize } from "superjson";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { ProposedChanges } from "./ProposedChanges";
import { QuestionReview } from "./QuestionReview";

test("approval review stays in a dialog while compact questions preserve drafts", async () => {
    const previousColors = process.env.DEBUG_COLORS;
    process.env.DEBUG_COLORS = "false";
    const id = crypto.randomUUID();
    const questionId = crypto.randomUUID();
    const proposals: MiraProposal[] = [
        {
            id: crypto.randomUUID(),
            tool: "mira_homelab_command",
            inputHash: "0".repeat(64),
            createdAt: new Date().toISOString(),
            input: { target: "main", command: "hostname", reason: "Inspect host" },
        },
        {
            id: questionId,
            tool: "mira_request_user_input",
            inputHash: "1".repeat(64),
            createdAt: new Date().toISOString(),
            input: {
                questions: [
                    {
                        id: "target",
                        title: "Which target?",
                        options: ["Main", "Daytona"],
                    },
                    { id: "note", title: "Any constraints?", options: [] },
                ],
            },
        },
    ];
    const saved: unknown[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (typeof init?.body === "string") {
                    saved.push(
                        (JSON.parse(init.body) as { "0": { json: unknown } })["0"].json
                    );
                    return Promise.resolve(
                        Response.json([
                            { result: { data: serialize({ state: "answered" }) } },
                        ])
                    );
                }
                return Promise.resolve(
                    Response.json([{ result: { data: serialize(proposals) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    query.setQueryData(["operations", "mira", "proposals", id], proposals);
    const identity = new IdentityClient();
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <ProposedChanges conversationId={id} />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    try {
        expect(screen.queryByText("hostname")).toBeNull();
        expect(screen.queryByRole("dialog")).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Review" }));
        expect(screen.getByRole("dialog")).toHaveTextContent("hostname");
        fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
        fireEvent.click(screen.getByRole("button", { name: "Next request" }));
        fireEvent.click(screen.getByRole("button", { name: "Main" }));
        fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), {
            target: { value: "No downtime" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Previous request" }));
        fireEvent.click(screen.getByRole("button", { name: "Next request" }));
        expect(
            (screen.getByRole("textbox", { name: "Your answer" }) as HTMLTextAreaElement)
                .value
        ).toBe("No downtime");
        fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
        expect(screen.queryByRole("textbox", { name: "Your answer" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Show question" }));
        expect(
            (screen.getByRole("textbox", { name: "Your answer" }) as HTMLTextAreaElement)
                .value
        ).toBe("No downtime");
        expect(saved).toEqual([]);
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        await waitFor(() => expect(saved).toHaveLength(1));
        expect(saved[0]).toEqual({
            id: questionId,
            inputHash: "1".repeat(64),
            answers: { target: "Main", note: "No downtime" },
        });
        const single = {
            ...proposals[1]!,
            id: crypto.randomUUID(),
            input: {
                questions: [{ id: "choice", title: "Choose one", options: ["Continue"] }],
            },
        };
        view.rerender(
            <QueryClientProvider client={query}>
                <IdentityClientContext value={identity}>
                    <QuestionReview proposal={single} />
                </IdentityClientContext>
            </QueryClientProvider>
        );
        expect(screen.queryByRole("button", { name: "Previous question" })).toBeNull();
        const choice = screen.getByRole("button", { name: "Continue" });
        fireEvent.click(choice);
        fireEvent.click(choice);
        await waitFor(() => expect(saved).toHaveLength(2));
        expect(saved[1]).toEqual({
            id: single.id,
            inputHash: single.inputHash,
            answers: { choice: "Continue" },
        });
    } finally {
        view.unmount();
        identity.cancelActions();
        query.clear();
        request.mockRestore();
        if (previousColors === undefined) delete process.env.DEBUG_COLORS;
        else process.env.DEBUG_COLORS = previousColors;
    }
});
