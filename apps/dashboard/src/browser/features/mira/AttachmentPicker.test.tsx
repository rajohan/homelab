import { expect, spyOn, test } from "bun:test";

import type { MiraAttachment } from "@homelab/contracts/mira";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { ChatComposer } from "./ChatComposer";

function Composer() {
    const [files, setFiles] = useState<MiraAttachment[]>([]);
    const [uploading, setUploading] = useState(false);
    return (
        <ChatComposer
            text="Inspect these"
            onText={() => {}}
            attachments={files}
            onAttachments={setFiles}
            uploading={uploading}
            onUploading={setUploading}
            active
            sending={false}
            stopping={false}
            stopPending={false}
            onSend={() => {}}
            onStop={() => {}}
            onBrowse={() => {}}
        />
    );
}

test("dropping multiple files into the writing field shares upload, preview and removal with the picker", async () => {
    const uploaded: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            async (
                _input: Parameters<typeof fetch>[0],
                init?: Parameters<typeof fetch>[1]
            ) => {
                await gate;
                const headers = new Headers(init?.headers);
                const name = decodeURIComponent(headers.get("x-file-name") ?? "");
                uploaded.push(name);
                return Response.json({
                    id: headers.get("x-file-id"),
                    name,
                    mediaType: "image/png",
                    bytes: 8,
                    createdAt: new Date().toISOString(),
                });
            },
            { preconnect: fetch.preconnect }
        )
    );
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={new IdentityClient()}>
                <Composer />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    try {
        const input = screen.getByRole("textbox", { name: "Message Mira" });
        const dataTransfer = {
            types: ["Files"],
            files: [new File(["fixture"], "one.png"), new File(["fixture"], "two.png")],
        };
        fireEvent.dragEnter(input, { dataTransfer });
        expect(screen.getByText("Drop files to attach")).toBeInTheDocument();
        expect(fireEvent.drop(input, { dataTransfer })).toBe(false);
        expect(screen.queryByText("Drop files to attach")).not.toBeInTheDocument();
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
        );
        fireEvent.drop(input, { dataTransfer });
        release!();
        await waitFor(() => expect(uploaded).toEqual(["one.png", "two.png"]));
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Send" })).toBeEnabled()
        );
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Attach files" }));
        expect(screen.getByRole("dialog", { name: "Attach files" })).toBeInTheDocument();
        expect(screen.getByText("2/8")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Preview one.png" }));
        expect(screen.getByRole("dialog", { name: "one.png" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Close dialog" }));
        await user.click(
            screen.getByRole("button", { name: "Remove one.png from message" })
        );
        expect(screen.getByText("1/8")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Done" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.getByText("two.png")).toBeInTheDocument();
        expect(screen.queryByText("one.png")).not.toBeInTheDocument();
    } finally {
        release!();
        view.unmount();
        query.clear();
        request.mockRestore();
    }
});
