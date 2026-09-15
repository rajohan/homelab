import { expect, spyOn, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { IdentityClient } from "../../api/IdentityClient";
import { ActivityPanel } from "./ActivityPanel";

test("activity pages expose account and timestamp columns, retry without dropping rows, and use server cursors", async () => {
    const client = new IdentityClient();
    let fail = true;
    const event = {
        id: "event-one",
        event: "password_changed",
        account: "operator",
        createdAt: "2026-01-01T12:34:56Z",
    };
    const read = spyOn(client, "activity").mockImplementation((cursor) => {
        if (cursor === null)
            return Promise.resolve({ events: [event], nextCursor: "next-page" });
        if (fail) return Promise.reject(new Error("Synthetic page failure"));
        return Promise.resolve({
            events: [{ ...event, id: "event-two", event: "email_verified" }],
            nextCursor: null,
        });
    });
    const query = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const view = render(
        <QueryClientProvider client={query}>
            <ActivityPanel client={client} accountId="fixture" />
        </QueryClientProvider>
    );
    try {
        expect(
            await screen.findByRole("table", { name: "Security activity" })
        ).toBeVisible();
        expect(screen.getByRole("columnheader", { name: "Who" })).toBeVisible();
        expect(screen.getByRole("columnheader", { name: "Time" })).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
        expect(await screen.findByText("Synthetic page failure")).toBeVisible();
        expect(screen.getByRole("table", { name: "Security activity" })).toBeVisible();
        fail = false;
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        await waitFor(() =>
            expect(
                screen.queryByRole("button", { name: "Load older events" })
            ).not.toBeInTheDocument()
        );
        expect(read.mock.calls.map(([cursor]) => cursor)).toEqual([
            null,
            "next-page",
            "next-page",
        ]);
    } finally {
        view.unmount();
        query.clear();
        read.mockRestore();
    }
});
