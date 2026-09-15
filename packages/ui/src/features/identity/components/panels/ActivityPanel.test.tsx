import { expect, test } from "bun:test";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AccountSnapshot } from "../../client";
import { ActivityPanel } from "./ActivityPanel";

test("security activity stays compact while keeping every returned event accessible", async () => {
    const data: AccountSnapshot = {
        user: {
            id: "fixture",
            username: "operator",
            email: "operator@example.test",
            emailVerified: true,
        },
        factors: [],
        sessions: [],
        recoveryCodesRemaining: 0,
        events: Array.from({ length: 11 }, (_, index) => ({
            id: String(index),
            event: "password_changed",
            createdAt: "2026-01-01T00:00:00Z",
        })),
    };
    const view = render(<ActivityPanel data={data} onAction={() => {}} />);
    try {
        expect(screen.getAllByRole("listitem")).toHaveLength(10);
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Show all 11 events" }));
        expect(screen.getAllByRole("listitem")).toHaveLength(11);
        await user.click(screen.getByRole("button", { name: "Show fewer events" }));
        expect(screen.getAllByRole("listitem")).toHaveLength(10);
    } finally {
        view.unmount();
    }
});
