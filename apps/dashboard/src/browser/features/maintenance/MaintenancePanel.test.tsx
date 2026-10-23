import { expect, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { ReleasesPanel } from "../releases/ReleasesPanel";
import { MaintenancePanel } from "./MaintenancePanel";

function fixture(children: ReactNode, key: string, data: unknown) {
    const client = new QueryClient({
        defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    client.setQueryData(["operations", key], data);
    render(
        <QueryClientProvider client={client}>
            <IdentityClientContext value={new IdentityClient()}>
                {children}
            </IdentityClientContext>
        </QueryClientProvider>
    );
    return () => {
        cleanup();
        client.clear();
    };
}

test("restart impact is confirmed in the shared dialog and cancellation submits nothing", async () => {
    const close = fixture(<MaintenancePanel />, "maintenance", [
        {
            target: "web",
            label: "Web service",
            impact: "The web service will be temporarily unavailable.",
            kind: "service",
            revision: "a".repeat(64),
            allowed: true,
            required: true,
            capturedAt: new Date().toISOString(),
            reason: null,
        },
    ]);
    try {
        expect(screen.getByText("Restart required")).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: "Restart…" }));
        expect(
            screen.getByRole("dialog", { name: "Restart Web service?" })
        ).toBeVisible();
        expect(screen.getByText(/A stopped service will not be started/)).toBeVisible();
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
        close();
    }
});

test("unavailable restart observations cannot enable a mutation", () => {
    const close = fixture(<MaintenancePanel />, "maintenance", [
        {
            target: "web",
            label: "Web service",
            impact: "Service unavailable during restart.",
            kind: "service",
            revision: "a".repeat(64),
            allowed: false,
            required: true,
            capturedAt: null,
            reason: "Refresh the restart status.",
        },
    ]);
    try {
        expect(screen.getByText("Requirement unknown")).toBeVisible();
        expect(screen.getByRole("button", { name: "Restart…" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    } finally {
        close();
    }
});

test("release publication is displayed separately from running versions and stale checks", () => {
    const close = fixture(<ReleasesPanel />, "releases", {
        configured: true,
        dashboard: "0.7.12",
        workers: [{ version: "0.7.12", online: true }],
        auth: [
            {
                version: "0.7.11",
                name: "auth",
                stale: true,
                capturedAt: "2026-10-20T10:00:00Z",
            },
        ],
        release: {
            fresh: false,
            capturedAt: "2026-10-21T10:00:00Z",
            value: {
                version: "0.8.0",
                verified: true,
                tests: "success",
                url: "https://github.com/demo/homelab/releases/tag/v0.8.0",
                buildUrl: null,
            },
        },
    });
    try {
        expect(screen.getByText("0.7.12")).toBeVisible();
        expect(screen.getByText("0.7.12 (responding)")).toBeVisible();
        expect(screen.getByText(/0.7.11.*stale/)).toBeVisible();
        expect(screen.getByRole("link", { name: "Published 0.8.0" })).toBeVisible();
        expect(screen.getByText("Release check is stale")).toBeVisible();
        expect(screen.queryByRole("button", { name: /deploy/i })).not.toBeInTheDocument();
    } finally {
        close();
    }
});
