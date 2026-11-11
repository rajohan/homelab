import { expect, test } from "bun:test";

import type { MiraMessage } from "@homelab/contracts/mira";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ChatTranscript } from "./ChatTranscript";

const message = (content: string): MiraMessage => ({
    id: crypto.randomUUID(),
    role: "assistant",
    state: "completed",
    content,
    attachmentIds: [],
    createdAt: new Date().toISOString(),
});

test("transcript follows replies and resized content only while the reader is at the bottom", () => {
    const previousObserver = globalThis.ResizeObserver;
    let resized!: () => void;
    let disconnected = false;
    globalThis.ResizeObserver = class {
        /** Capture the callback so the test can deliver a browser resize notification. */
        constructor(callback: ResizeObserverCallback) {
            resized = () => callback([], this);
        }
        /** Accept a fixture target without depending on a layout engine. */
        observe() {}
        /** Release a fixture target. */
        unobserve() {}
        /** Record cleanup when the transcript unmounts. */
        disconnect() {
            disconnected = true;
        }
    };
    const messages = [message("First answer")];
    const view = render(
        <ChatTranscript
            messages={messages}
            before={undefined}
            nextCursor={null}
            onPage={() => {}}
        />
    );
    try {
        const log = screen.getByRole("log");
        let height = 1200;
        Object.defineProperties(log, {
            clientHeight: { configurable: true, value: 500 },
            scrollHeight: { configurable: true, get: () => height },
        });
        act(() => resized());
        expect(log.scrollTop).toBe(height);
        expect(
            screen.queryByRole("button", { name: "Back to bottom" })
        ).not.toBeInTheDocument();
        height = 1400;
        view.rerender(
            <ChatTranscript
                messages={[...messages, message("Next answer")]}
                before={undefined}
                nextCursor={null}
                onPage={() => {}}
            />
        );
        expect(log.scrollTop).toBe(1400);
        log.scrollTop = 200;
        fireEvent.scroll(log);
        expect(screen.getByRole("button", { name: "Back to bottom" })).toBeVisible();
        height = 1800;
        view.rerender(
            <ChatTranscript
                messages={[...messages, message("Streaming answer")]}
                activity={<p>Thinking…</p>}
                before={undefined}
                nextCursor={null}
                onPage={() => {}}
            />
        );
        act(() => resized());
        expect(log.scrollTop).toBe(200);
        fireEvent.click(screen.getByRole("button", { name: "Back to bottom" }));
        expect(log.scrollTop).toBe(height);
        height = 2000;
        act(() => resized());
        expect(log.scrollTop).toBe(height);
        expect(
            screen.queryByRole("button", { name: "Back to bottom" })
        ).not.toBeInTheDocument();
        log.scrollTop = height - 500;
        fireEvent.scroll(log);
        height = 2100;
        act(() => resized());
        expect(log.scrollTop).toBe(height);
    } finally {
        view.unmount();
        globalThis.ResizeObserver = previousObserver;
    }
    expect(disconnected).toBe(true);
});

test("back to bottom loads the latest page when reading older messages", () => {
    const pages: (string | undefined)[] = [];
    render(
        <ChatTranscript
            messages={[message("Older reply")]}
            before="older-page"
            nextCursor={null}
            onPage={(cursor) => pages.push(cursor)}
        />
    );
    const log = screen.getByRole("log");
    expect(log.scrollTop).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Back to bottom" }));
    expect(pages).toEqual([undefined]);
});
