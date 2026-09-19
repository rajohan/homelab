import { expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { NotificationCenter } from "./NotificationCenter";
import { NotificationPanel } from "./NotificationPanel";

function fixture(content: ReactNode, seed: (query: QueryClient) => void) {
    const query = new QueryClient({
        defaultOptions: {
            queries: { enabled: false, staleTime: Infinity, retry: false },
        },
    });
    seed(query);
    const view = render(
        <QueryClientProvider client={query}>{content}</QueryClientProvider>
    );
    return () => {
        view.unmount();
        query.clear();
    };
}
const empty = {
    notifications: [],
    nextCursor: null,
    through: null,
    unreadCount: 0,
    readCount: 0,
};

test("the inbox filters read state and severity without pretending empty data is still loading", async () => {
    const cleanup = fixture(<NotificationPanel />, (query) => {
        for (const filters of [
            { state: "all" },
            { state: "unread" },
            { state: "unread", severity: "error" },
        ])
            query.setQueryData(["notifications", "history", filters], {
                pages: [empty],
                pageParams: [undefined],
            });
    });
    try {
        const user = userEvent.setup();
        expect(screen.getByText("0 unread · 0 read")).toBeVisible();
        expect(screen.getByText("No matching notifications.")).toHaveClass("border");
        expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Clear read" })).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "Notification read state" }));
        await user.click(screen.getByRole("option", { name: "Unread" }));
        await user.click(screen.getByRole("button", { name: "Notification severity" }));
        await user.click(screen.getByRole("option", { name: "Error" }));
        expect(
            screen.getByRole("button", { name: "Notification severity" })
        ).toHaveTextContent("Error");
        expect(screen.getByText("No matching notifications.")).toBeVisible();
    } finally {
        cleanup();
    }
});

test("clearing read notifications requires confirmation and preserves the operator boundary", async () => {
    const cleanup = fixture(<NotificationPanel />, (query) =>
        query.setQueryData(["notifications", "history", { state: "all" }], {
            pages: [
                {
                    ...empty,
                    readCount: 2,
                    unreadCount: 1,
                    through: "1",
                },
            ],
            pageParams: [undefined],
        })
    );
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Clear read" }));
        expect(
            screen.getByRole("dialog", { name: "Clear read notifications?" })
        ).toBeVisible();
        expect(
            screen.getByText(/Other operators’ notifications are unchanged/)
        ).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test("the global bell opens history only on demand and caps its visual count", async () => {
    const cleanup = fixture(<NotificationCenter />, (query) => {
        query.setQueryData(["notifications", "count"], { ...empty, unreadCount: 120 });
        query.setQueryData(["notifications", "history", { state: "all" }], {
            pages: [empty],
            pageParams: [undefined],
        });
    });
    try {
        expect(
            screen.queryByRole("region", { name: "Notification inbox" })
        ).not.toBeInTheDocument();
        expect(screen.getByText("99+")).toBeVisible();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Notifications, 120 unread" }));
        expect(screen.getByRole("region", { name: "Notification inbox" })).toBeVisible();
    } finally {
        cleanup();
    }
});
