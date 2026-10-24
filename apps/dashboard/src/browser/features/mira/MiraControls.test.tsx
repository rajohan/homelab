import { expect, spyOn, test } from "bun:test";

import type { MiraAttachment } from "@homelab/contracts/mira";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { AttachmentPicker } from "./AttachmentPicker";
import { AutomationEditor } from "./AutomationEditor";
import { ChatComposer } from "./ChatComposer";
import { ChatMessage } from "./ChatMessage";

function UploadHarness({ onBusy }: { readonly onBusy: (busy: boolean) => void }) {
    const [files, setFiles] = useState<MiraAttachment[]>([]);
    return <AttachmentPicker value={files} onChange={setFiles} onBusyChange={onBusy} />;
}

function fixture(content: ReactNode) {
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
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
