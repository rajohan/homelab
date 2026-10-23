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
                <div
                    ref={(element) => {
                        const viewport = element?.querySelector(
                            '[aria-label="Restart targets"]'
                        );
                        if (viewport)
                            Object.defineProperties(viewport, {
                                offsetHeight: { configurable: true, value: 520 },
                                clientHeight: { configurable: true, value: 520 },
                                clientWidth: { configurable: true, value: 960 },
                            });
                    }}
                >
                    {children}
                </div>
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
        await userEvent.click(screen.getByRole("button", { name: "Restart" }));
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
        expect(screen.getByRole("button", { name: "Restart" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
    } finally {
        close();
    }
});

test("release publication is displayed separately from running versions and stale checks", () => {
    const close = fixture(<ReleasesPanel />, "releases", {
        configured: true,
        dashboard: "0.7.12",
        workers: [{ version: "0.7.10", online: true }],
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
                buildUrl: "https://github.com/demo/homelab/actions/runs/123",
            },
        },
    });
    try {
        expect(screen.getByText("0.7.12")).toBeVisible();
        expect(screen.getByText("0.7.10")).toBeVisible();
        expect(screen.getByText(/0.7.11.*outdated/)).toBeVisible();
        expect(screen.getByRole("heading", { name: "Published 0.8.0" })).toBeVisible();
        expect(screen.getByRole("link", { name: "View release" })).toHaveAttribute(
            "href",
            "https://github.com/demo/homelab/releases/tag/v0.8.0"
        );
        expect(screen.getByText("Status outdated")).toBeVisible();
        expect(screen.getByRole("link", { name: "View release build" })).toHaveAttribute(
            "href",
            "https://github.com/demo/homelab/actions/runs/123"
        );
        expect(screen.queryByText("Verified release")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /deploy/i })).not.toBeInTheDocument();
    } finally {
        close();
    }
});

test.each([
    [true, "Restart required"],
    [false, "No restart required"],
    [null, "Requirement unknown"],
] as const)(
    "external targets preserve requirement status %s and offer read-only refresh",
    (required, label) => {
        const close = fixture(<MaintenancePanel />, "maintenance", [
            {
                target: "worker-host",
                label: "Worker host",
                impact: "Dashboard and worker will be unavailable.",
                kind: "host",
                revision: "a".repeat(64),
                allowed: false,
                external: true,
                required,
                capturedAt: new Date().toISOString(),
                reason: "Restart from the host console.",
            },
        ]);
        try {
            expect(screen.getByText("External restart")).toBeVisible();
            expect(screen.getByText(label)).toBeVisible();
            expect(screen.getByText("Restart from the host console.")).toBeVisible();
            expect(
                screen.queryByRole("button", { name: "Restart" })
            ).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Refresh status" })).toBeEnabled();
        } finally {
            close();
        }
    }
);

test.each([false, true])(
    "release status reflects exact publication verification: %s",
    (verified) => {
        const close = fixture(<ReleasesPanel />, "releases", {
            configured: true,
            dashboard: "0.7.12",
            workers: [],
            auth: [],
            release: {
                fresh: true,
                capturedAt: "2026-10-23T10:00:00Z",
                value: {
                    version: "0.8.0",
                    verified,
                    tests: "success",
                    url: "https://github.com/demo/homelab/releases/tag/v0.8.0",
                    buildUrl: null,
                },
            },
        });
        try {
            expect(
                screen.getByText(verified ? "Verified release" : "Not verified")
            ).toBeVisible();
            expect(
                screen.queryByText(verified ? "Not verified" : "Verified release")
            ).not.toBeInTheDocument();
        } finally {
            close();
        }
    }
);
