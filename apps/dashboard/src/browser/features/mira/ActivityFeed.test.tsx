import { expect, test } from "bun:test";

import { fireEvent, render, screen } from "@testing-library/react";

import { ActivityFeed } from "./ActivityFeed";
import { ProviderQuota } from "./ProviderQuota";

test("activity follows new rows until the reader scrolls up and resumes on demand", () => {
    const view = render(
        <ActivityFeed count={1}>
            <p>First</p>
        </ActivityFeed>
    );
    try {
        const viewport = view.container.querySelector(".overflow-y-auto")!;
        let height = 1000;
        Object.defineProperty(viewport, "scrollHeight", { get: () => height });
        Object.defineProperty(viewport, "clientHeight", { value: 200 });
        view.rerender(
            <ActivityFeed count={2}>
                <p>Second</p>
            </ActivityFeed>
        );
        expect(viewport.scrollTop).toBe(1000);
        viewport.scrollTop = 200;
        fireEvent.scroll(viewport);
        height = 1200;
        view.rerender(
            <ActivityFeed count={3}>
                <p>Third</p>
            </ActivityFeed>
        );
        expect(viewport.scrollTop).toBe(200);
        fireEvent.click(screen.getByRole("button", { name: "Latest activity" }));
        expect(viewport.scrollTop).toBe(1200);
    } finally {
        view.unmount();
    }
});

test("quota distinguishes zero allowance from missing and stale telemetry", () => {
    const observedAt = "2026-11-16T12:00:00Z";
    const quota = [
        {
            provider: "chatgpt" as const,
            observedAt,
            windows: [{ label: "Primary", remainingPercent: 0, resetsAt: null }],
        },
    ];
    const view = render(
        <ProviderQuota quotas={quota} fresh now={Date.parse(observedAt)} />
    );
    try {
        expect(screen.getByText(/ChatGPT: 0% left/)).toHaveTextContent(
            "Synthetic: unavailable"
        );
        view.rerender(
            <ProviderQuota quotas={quota} fresh now={Date.parse(observedAt) + 100_000} />
        );
        expect(screen.getByText(/ChatGPT: unavailable/)).toBeInTheDocument();
        expect(screen.getByText(/Last reported values/)).toBeInTheDocument();
    } finally {
        view.unmount();
    }
});
