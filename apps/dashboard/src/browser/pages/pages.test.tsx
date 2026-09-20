import { describe, expect, mock, spyOn, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DashboardApp } from "../DashboardApp";
import { ConnectionStatus } from "../features/overview/ConnectionStatus";
import { createDashboardRouter } from "../router";
import { Overview } from "./Overview";

const readyStatus = {
    name: "Homelab",
    version: "0.1.0",
    phase: "operations",
    authenticationImplemented: true,
    integrationsImplemented: true,
    operationsConfigured: true,
    service: "dashboard",
    status: "ok",
    auth: { provider: "homelab" },
} as const;

describe("dashboard foundation", () => {
    test.each(["unconfigured", "pending", "failed", "configured"] as const)(
        "overview keeps account access and gates operations when status is %s",
        async (state) => {
            const query = new QueryClient({
                defaultOptions: {
                    queries: { enabled: false, retry: false, staleTime: Infinity },
                },
            });
            if (state !== "pending")
                query.setQueryData(["system", "status"], {
                    ...readyStatus,
                    operationsConfigured: state !== "unconfigured",
                });
            if (state === "failed")
                query
                    .getQueryCache()
                    .find({ queryKey: ["system", "status"] })
                    ?.setState({
                        status: "error",
                        error: new Error("Synthetic API failure"),
                    });
            const router = createRouter({
                routeTree: createRootRoute({ component: Overview }),
                history: createMemoryHistory({ initialEntries: ["/"] }),
            });
            await router.load();
            const view = render(
                <QueryClientProvider client={query}>
                    <RouterProvider router={router} />
                </QueryClientProvider>
            );
            try {
                expect(
                    await screen.findByRole("heading", { name: "Overview" })
                ).toBeVisible();
                if (state === "configured") {
                    expect(
                        screen.getByRole("heading", { name: "Infrastructure health" })
                    ).toBeVisible();
                    expect(
                        query.getQueryCache().findAll({ queryKey: ["operations"] }).length
                    ).toBeGreaterThan(0);
                    act(() => {
                        query.setQueryData(["system", "status"], {
                            ...readyStatus,
                            operationsConfigured: false,
                        });
                    });
                    expect(
                        await screen.findByRole("heading", { name: "Account & security" })
                    ).toBeVisible();
                    expect(
                        screen.queryByRole("heading", { name: "Infrastructure health" })
                    ).not.toBeInTheDocument();
                    expect(
                        query
                            .getQueryCache()
                            .findAll({ queryKey: ["operations"] })
                            .every((entry) => entry.getObserversCount() === 0)
                    ).toBe(true);
                } else {
                    expect(
                        query.getQueryCache().findAll({ queryKey: ["operations"] })
                    ).toHaveLength(0);
                    expect(
                        screen.queryByRole("heading", { name: "Infrastructure health" })
                    ).not.toBeInTheDocument();
                }
                expect(
                    screen.getByRole("link", { name: "Open settings" })
                ).toHaveAttribute("href", "/settings");
                if (state === "unconfigured" || state === "configured")
                    expect(
                        screen.getByText(
                            "Operations are not configured. Account settings and sign-in remain available."
                        )
                    ).toBeVisible();
                if (state === "pending")
                    expect(
                        screen.getByRole("status", {
                            name: "Checking this application's API…",
                        })
                    ).toBeVisible();
                if (state === "failed")
                    expect(
                        screen.getByRole("button", { name: "Try again" })
                    ).toBeVisible();
            } finally {
                view.unmount();
                query.clear();
                router.history.destroy();
            }
        }
    );

    test("clearly separates API connectivity from infrastructure health", () => {
        render(
            <ConnectionStatus
                pending={false}
                failed={false}
                data={readyStatus}
                onRetry={() => {}}
            />
        );
        expect(screen.getByText("Connected")).toBeVisible();
        expect(screen.getByText("The dashboard can reach its own API.")).toBeVisible();
        expect(screen.queryByText("All systems operational")).not.toBeInTheDocument();
    });

    test("shows a pending connection without claiming success", () => {
        render(<ConnectionStatus pending failed={false} onRetry={() => {}} />);
        expect(
            screen.getByRole("status", { name: "Checking this application's API…" })
        ).toBeVisible();
        expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    });

    test("offers retry without exposing backend error details", async () => {
        const user = userEvent.setup();
        const retry = mock(() => {});
        render(<ConnectionStatus pending={false} failed onRetry={retry} />);
        expect(screen.getByText("Unavailable")).toBeVisible();
        const button = screen.getByRole("button", { name: "Try again" });
        await user.tab();
        expect(button).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(retry).toHaveBeenCalledTimes(1);
    });

    test("navigates to account settings behind the identity boundary", async () => {
        const user = userEvent.setup();
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        queryClient.setQueryDefaults(["operations"], { enabled: false });
        queryClient.setQueryData(["system", "status"], readyStatus);
        const session = spyOn(IdentityClient.prototype, "session").mockResolvedValue({
            authenticated: true,
            mfaRequired: false,
            methods: [],
        });
        const account = spyOn(IdentityClient.prototype, "snapshot").mockRejectedValue(
            new Error("Test account is unavailable")
        );
        const router = createDashboardRouter(
            createMemoryHistory({ initialEntries: ["/"] })
        );
        render(<DashboardApp router={router} queryClient={queryClient} />);
        expect(await screen.findByRole("heading", { name: "Overview" })).toBeVisible();
        await user.click(screen.getByRole("link", { name: "Settings" }));
        expect(
            await screen.findByRole("heading", {
                name: "Account settings",
            })
        ).toBeVisible();
        expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
        queryClient.clear();
        session.mockRestore();
        account.mockRestore();
    });
});
