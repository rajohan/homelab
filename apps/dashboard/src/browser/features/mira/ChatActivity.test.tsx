import { expect, test } from "bun:test";

import type { MiraRun } from "@homelab/contracts/mira";
import { render, screen } from "@testing-library/react";

import { ChatActivity } from "./ChatActivity";
import { ChatMessage } from "./ChatMessage";
import { readChatDisplay } from "./chatDisplay";

const run: MiraRun = { id: "run", conversationId: "chat", taskId: null, automationId: null, state: "running", cancelRequested: false, message: null, createdAt: "2026-11-15T12:00:00Z", startedAt: null, finishedAt: null, activity: { phase: "thinking", tool: null, thinking: "Provider display summary" } };
const display = { showThinking: false, showTools: false, expandTools: false };

test("work status is always shown while active and removed on completion, independently of thinking", () => {
    const view = render(<ChatActivity run={run} tools={[]} display={display} />);
    try {
        expect(screen.getByRole("status")).toHaveTextContent("Thinking…");
        expect(screen.queryByText("Provider display summary")).not.toBeInTheDocument();
        view.rerender(<ChatActivity run={run} tools={[]} display={{ ...display, showThinking: true }} />);
        expect(screen.getByText("Provider display summary")).toBeInTheDocument();
        view.rerender(<ChatActivity run={{ ...run, state: "completed" }} tools={[]} display={{ ...display, showThinking: true }} />);
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
        expect(screen.getByText("Provider display summary")).toBeInTheDocument();
    } finally { view.unmount(); }
});

test.each(["queued", "streaming", "completed", "failed", "interrupted"] as const)("empty assistant %s entries never create placeholder bubbles", (state) => {
    const view = render(<ChatMessage message={{ id: "empty", role: "assistant", content: "  ", state, attachmentIds: [], createdAt: run.createdAt }} />);
    try { expect(screen.queryByRole("article")).not.toBeInTheDocument(); }
    finally { view.unmount(); }
});

test("display migration preserves tool choices without preserving a hidden work status", () => {
    localStorage.setItem("homelab:mira:chat-display:v1", JSON.stringify({ showActivity: false, keepActivity: true, showTools: false, expandTools: true }));
    try { expect(readChatDisplay()).toEqual({ showThinking: true, showTools: false, expandTools: true }); }
    finally { localStorage.removeItem("homelab:mira:chat-display:v1"); }
});
