import { expect, test } from "bun:test";

import type { ManagedApplication } from "@homelab/contracts/applications";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { Applications } from "../../pages/Applications";
import { ApplicationActions } from "./ApplicationActions";
import { ApplicationInspector } from "./ApplicationInspector";
import { ApplicationLogLine } from "./ApplicationLogLine";
import { ApplicationLogs } from "./ApplicationLogs";
import { ApplicationStatus } from "./ApplicationStatus";

const application: ManagedApplication = {
    id: "demo:abc",
    host: "demo",
    containerId: "a".repeat(64),
    name: "web",
    containerName: "demo-web",
    project: "demo",
    image: "example/web:1",
    imageId: "sha256:123",
    state: "running",
    health: "healthy",
    startedAt: "2026-09-01T12:00:00Z",
    revision: "b".repeat(64),
    ports: [],
    mounts: [],
    networks: ["demo_default"],
};

function fixture(content: ReactNode, seed?: (query: QueryClient) => void) {
    const identity = new IdentityClient();
    const query = new QueryClient({
        defaultOptions: {
            queries: { enabled: false, staleTime: Infinity, retry: false },
        },
    });
    seed?.(query);
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <div
                    ref={(element) => {
                        // Happy DOM has no layout; supply each local virtual table's viewport.
                        for (const viewport of element?.querySelectorAll(
                            "section[aria-label]"
                        ) ?? [])
                            Object.defineProperties(viewport, {
                                offsetHeight: { value: 520, configurable: true },
                                offsetWidth: { value: 960, configurable: true },
                            });
                    }}
                >
                    {content}
                </div>
            </IdentityClientContext>
        </QueryClientProvider>
    );
    return () => {
        view.unmount();
        identity.cancelActions();
        query.clear();
    };
}

test("application lifecycle menus require an explicit cancellable confirmation", async () => {
    const cleanup = fixture(
        <ApplicationActions
            host="demo"
            selection={{ kind: "container", target: application.containerId }}
            revision={application.revision}
            name="web"
            states={["running", "exited"]}
        />
    );
    try {
        const user = userEvent.setup();
        for (const operation of ["Start", "Stop", "Restart"]) {
            await user.click(screen.getByRole("button", { name: "Actions for web" }));
            await user.click(screen.getByRole("menuitem", { name: operation }));
            expect(
                screen.getByRole("dialog", { name: `${operation} web?` })
            ).toBeVisible();
            expect(screen.getByRole("button", { name: operation })).toBeEnabled();
            await user.click(screen.getByRole("button", { name: "Cancel" }));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        }
    } finally {
        cleanup();
    }
});

test.each([
    { states: ["running"], actions: ["Restart", "Stop"] },
    { states: ["exited"], actions: ["Start"] },
    { states: ["created"], actions: ["Start"] },
    { states: ["paused"], actions: ["Stop"] },
    { states: ["running", "exited"], actions: ["Start", "Restart", "Stop"] },
])("lifecycle menus reflect current states ($states)", async ({ states, actions }) => {
    const cleanup = fixture(
        <ApplicationActions
            host="demo"
            selection={{ kind: "container", target: application.containerId }}
            revision={application.revision}
            name="web"
            states={states}
        />
    );
    try {
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Actions for web" }));
        expect(
            screen.getAllByRole("menuitem").map((item) => item.textContent ?? "")
        ).toEqual([...actions]);
    } finally {
        cleanup();
    }
});

test("application inspector avoids exposing raw config and keeps log fetching behind its view", async () => {
    const cleanup = fixture(
        <ApplicationInspector
            application={application}
            logsAvailable
            available
            onClose={() => {}}
        />
    );
    try {
        expect(screen.getByRole("dialog", { name: /web/ })).toBeVisible();
        expect(screen.getByText("example/web:1")).toBeVisible();
        expect(screen.getByText("No published ports.")).toBeVisible();
        expect(screen.getByText("No mounts.")).toBeVisible();
        expect(screen.queryByText("Environment")).not.toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "View" }));
        await user.click(screen.getByRole("option", { name: "Logs" }));
        expect(screen.getByRole("searchbox", { name: "Search logs" })).toBeVisible();
        expect(screen.getByRole("switch", { name: "Live updates" })).toBeChecked();
    } finally {
        cleanup();
    }
});

test("log controls pause live refresh and present empty history without load-more buttons", async () => {
    const cleanup = fixture(<ApplicationLogs application={application} />, (query) =>
        query.setQueryData(
            ["operations", "applications", "logs", application.id, "24h", "", 0],
            { pages: [{ entries: [], nextCursor: null }], pageParams: [undefined] }
        )
    );
    try {
        const user = userEvent.setup();
        expect(
            screen.getByText(
                "No matching entries in this time range. Try a wider range or clear the search."
            )
        ).toHaveClass("border", "bg-primary-950/40");
        await user.click(screen.getByRole("switch", { name: "Live updates" }));
        expect(screen.getByRole("switch", { name: "Live updates" })).not.toBeChecked();
        await user.type(
            screen.getByRole("searchbox", { name: "Search logs" }),
            "failure"
        );
        expect(screen.getByRole("searchbox", { name: "Search logs" })).toHaveValue(
            "failure"
        );
        await user.click(screen.getByRole("button", { name: "Clear log search" }));
        expect(screen.getByRole("searchbox", { name: "Search logs" })).toHaveValue("");
        await user.click(screen.getByRole("button", { name: "Time range" }));
        await user.click(screen.getByRole("option", { name: "Last 24h" }));
        expect(screen.getByRole("button", { name: "Time range" })).toHaveTextContent(
            "Last 24h"
        );
        expect(
            screen.queryByRole("button", { name: /Load more/ })
        ).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test("log text remains escaped and Docker health distinguishes errors, warnings and stopped state", () => {
    const cleanup = fixture(
        <>
            <ApplicationLogLine
                entry={{
                    id: "1",
                    timestamp: "1788253200000000000",
                    message: '<img src=x onerror="alert(1)">',
                    level: "error",
                }}
            />
            <ApplicationStatus state="running" health="unhealthy" />
            <ApplicationStatus state="running" health="starting" />
            <ApplicationStatus state="exited" health={null} />
            <ApplicationStatus state="running" health={null} />
            <ApplicationStatus state="running" health="healthy" available={false} />
        </>
    );
    try {
        expect(document.querySelector("img")).toBeNull();
        expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeVisible();
        for (const label of ["Unhealthy", "Starting", "Exited", "Running", "Unknown"])
            expect(screen.getByText(label)).toBeVisible();
    } finally {
        cleanup();
    }
});

test("the applications workspace reports disabled provisioning without implying Docker access", () => {
    const cleanup = fixture(<Applications />, (query) =>
        query.setQueryData(["operations", "applications", "inventory"], {
            configured: false,
            inventory: null,
            projects: [],
            logHosts: [],
            fresh: false,
        })
    );
    try {
        expect(screen.getByRole("heading", { name: "Applications" })).toBeVisible();
        expect(screen.getByText(/Application control is not configured/)).toBeVisible();
        expect(
            screen.queryByRole("button", { name: /Actions for/ })
        ).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test.each([true, false])(
    "application controls honor server freshness (%s), independent of browser date comparisons",
    (fresh) => {
        const cleanup = fixture(<Applications />, (query) =>
            query.setQueryData(["operations", "applications", "inventory"], {
                configured: true,
                fresh,
                logHosts: [],
                inventory: {
                    capturedAt: fresh ? "2000-01-01T00:00:00Z" : "2099-01-01T00:00:00Z",
                    hosts: [
                        {
                            id: "demo",
                            label: "Demo",
                            available: true,
                            applications: [application],
                        },
                    ],
                },
                projects: [
                    { host: "demo", name: "demo", revision: application.revision },
                ],
            })
        );
        try {
            expect(
                screen.getByText(fresh ? "Live inventory" : "Stale inventory")
            ).toBeVisible();
            const action = screen.getByRole("button", { name: "Actions for demo" });
            if (fresh) expect(action).toBeEnabled();
            else expect(action).toBeDisabled();
        } finally {
            cleanup();
        }
    }
);
