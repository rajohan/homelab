import { expect, spyOn, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { ChatComposer } from "./ChatComposer";

test.each([
    [true, false],
    [true, true],
    [false, false],
    [false, true],
])(
    "Enter follows the device during idle and active work: pointer fine=%s, active=%s",
    (desktop, active) => {
        const media = spyOn(globalThis, "matchMedia").mockImplementation((query) => ({
            matches: query === "(pointer: fine)" && desktop,
            media: query,
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {},
            dispatchEvent: () => true,
        }));
        let sent = 0;
        const query = new QueryClient();
        const view = render(
            <QueryClientProvider client={query}>
                <IdentityClientContext value={new IdentityClient()}>
                    <ChatComposer
                        steerable
                        text="A message"
                        onText={() => {}}
                        attachments={[]}
                        onAttachments={() => {}}
                        uploading={false}
                        onUploading={() => {}}
                        sending={false}
                        active={Boolean(active)}
                        stopping={false}
                        stopPending={false}
                        onStop={() => {}}
                        onSend={() => {
                            sent++;
                        }}
                        onBrowse={() => {}}
                    />
                </IdentityClientContext>
            </QueryClientProvider>
        );
        try {
            const input = screen.getByRole("textbox", { name: "Message Mira" });
            fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
            fireEvent.keyDown(input, { key: "Enter", isComposing: true });
            expect(sent).toBe(0);
            expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(!desktop);
            expect(sent).toBe(desktop ? 1 : 0);
            expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
            if (active)
                expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
        } finally {
            view.unmount();
            query.clear();
            media.mockRestore();
        }
    }
);

test.each(["automatic", "stopping", "stop-pending"])(
    "%s work allows drafting but blocks sends and attachments",
    (mode) => {
        let sent = 0;
        const query = new QueryClient();
        const view = render(
            <QueryClientProvider client={query}>
                <IdentityClientContext value={new IdentityClient()}>
                    <ChatComposer
                        text="Draft"
                        onText={() => {}}
                        attachments={[]}
                        onAttachments={() => {}}
                        uploading={false}
                        onUploading={() => {}}
                        sending={false}
                        active
                        steerable={mode !== "automatic"}
                        stopping={mode === "stopping"}
                        stopPending={mode === "stop-pending"}
                        onStop={() => {}}
                        onSend={() => {
                            sent++;
                        }}
                        onBrowse={() => {}}
                    />
                </IdentityClientContext>
            </QueryClientProvider>
        );
        try {
            const input = screen.getByRole("textbox", { name: "Message Mira" });
            expect(input).toBeEnabled();
            expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
            fireEvent.keyDown(input, { key: "Enter" });
            fireEvent.submit(input.closest("form")!);
            expect(sent).toBe(0);
            expect(view.container.querySelector('input[type="file"]')).toBeDisabled();
        } finally {
            view.unmount();
            query.clear();
        }
    }
);
