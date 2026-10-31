import { expect, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { DeploymentPanel } from "./DeploymentPanel";

function fixture(data: unknown) {
    const client = new QueryClient({
        defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    client.setQueryData(["operations", "deployment"], data);
    render(
        <QueryClientProvider client={client}>
            <IdentityClientContext value={new IdentityClient()}>
                <DeploymentPanel />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    return () => {
        cleanup();
        client.clear();
    };
}

test("deployment confirmation names the frozen version and cancellation submits nothing", async () => {
    const close = fixture({
        targets: [
            {
                id: "main",
                label: "Dashboard and Mira",
                version: "1.2.3",
                revision: "a".repeat(64),
            },
        ],
        history: [],
    });
    try {
        await userEvent.click(screen.getByRole("button", { name: "Deploy release" }));
        const dialog = screen.getByRole("dialog", { name: "Deploy 1.2.3?" });
        expect(within(dialog).getByText(/database backup/)).toBeVisible();
        await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
        close();
    }
});

test.each(["running", "unknown", "failed"])(
    "active %s deployment blocks another launch and cannot be cancelled",
    (state) => {
        const close = fixture({
            targets: [
                {
                    id: "main",
                    label: "Dashboard and Mira",
                    version: "1.2.3",
                    revision: "a".repeat(64),
                },
            ],
            history: [
                {
                    id: crypto.randomUUID(),
                    target: "main",
                    version: "1.2.3",
                    state,
                    phase: "inspection",
                    active: true,
                    message: "Work remains paused until recovery.",
                },
            ],
        });
        try {
            expect(screen.getByRole("button", { name: "Deploy release" })).toBeDisabled();
            expect(
                screen.getByRole("button", { name: "Prepare release" })
            ).toBeDisabled();
            expect(
                screen.queryByRole("button", { name: "Cancel deployment" })
            ).not.toBeInTheDocument();
            expect(screen.getByRole("status")).toHaveTextContent(
                "Work remains paused until recovery."
            );
        } finally {
            close();
        }
    }
);

test("expired preparation disables deployment while retaining the prepare action", () => {
    const close = fixture({
        targets: [
            { id: "main", label: "Dashboard and Mira", version: null, revision: null },
        ],
        history: [],
    });
    try {
        expect(screen.getByRole("button", { name: "Deploy release" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Prepare release" })).toBeEnabled();
    } finally {
        close();
    }
});

test("a waiting deployment offers cancellation and empty configuration stays hidden", () => {
    let close = fixture({
        targets: [],
        history: [
            {
                id: crypto.randomUUID(),
                target: "main",
                version: "1.2.3",
                state: "waiting",
                phase: "draining",
                active: true,
                message: "Waiting for active work.",
            },
        ],
    });
    try {
        expect(screen.getByRole("button", { name: "Cancel deployment" })).toBeEnabled();
    } finally {
        close();
    }
    close = fixture({ targets: [], history: [] });
    try {
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    } finally {
        close();
    }
});
