import { expect, test } from "bun:test";

import type { MiraMessage } from "@homelab/contracts/mira";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { intersectionFixture } from "../../../../../../tests/intersectionFixture";
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
            continuation={{ hasMore: false, loading: false, onLoadMore: () => {} }}
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
                continuation={{ hasMore: false, loading: false, onLoadMore: () => {} }}
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
                continuation={{ hasMore: false, loading: false, onLoadMore: () => {} }}
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

test("older messages prepend automatically, preserving the reader while live replies remain available", () => {
    const fixture = intersectionFixture();
    const screen = within(fixture.container);
    const current = message("Current answer");
    let loads = 0;
    const continuation = {
        hasMore: true,
        loading: false,
        onLoadMore: () => {
            loads += 1;
        },
    };
    const view = render(
        <ChatTranscript messages={[current]} continuation={continuation} />,
        { container: fixture.container }
    );
    try {
        const log = screen.getByRole("log");
        Object.defineProperties(log, {
            clientHeight: { value: 500 },
            scrollHeight: { value: 1800 },
        });
        log.scrollTop = 20;
        fireEvent.scroll(log);
        const original =
            fixture.container.querySelector<HTMLElement>("[data-message-id]")!;
        let offset = 70;
        original.getBoundingClientRect = () =>
            ({ top: offset - log.scrollTop }) as DOMRect;
        act(() => {
            fixture.intersect();
            fixture.intersect();
        });
        expect(loads).toBe(1);
        view.rerender(
            <ChatTranscript
                messages={[current]}
                continuation={{ ...continuation, loading: true }}
            />
        );
        // A user scroll while fetching must not be undone by the prepend.
        log.scrollTop = 40;
        fireEvent.scroll(log);
        offset = 670;
        view.rerender(
            <ChatTranscript
                messages={[message("Older answer"), current, message("Live reply")]}
                continuation={{ ...continuation, hasMore: false }}
            />
        );
        expect(log.scrollTop).toBe(640);
        expect(screen.getByText("Older answer")).toBeVisible();
        expect(screen.getByText("Live reply")).toBeVisible();
        expect(
            screen.queryByRole("button", {
                name: /Older messages|Latest messages|Load more/,
            })
        ).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Back to bottom" }));
        expect(log.scrollTop).toBe(1800);
    } finally {
        view.unmount();
        fixture.close();
    }
});
