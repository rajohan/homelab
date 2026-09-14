import { describe, expect, mock, test } from "bun:test";

import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConnectionStatus, DashboardApp } from "./app";
import { createDashboardRouter } from "./browser/router";

const readyStatus = {
    name: "Homelab",
    version: "0.1.0",
    phase: "foundation",
    authenticationImplemented: false,
    integrationsImplemented: false,
    service: "dashboard",
    status: "ok",
    auth: { provider: "authelia", replacementEnabled: false },
} as const;

describe("dashboard foundation", () => {
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
        expect(screen.getByText("Checking this application's API…")).toBeVisible();
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

    test("navigates to identity without providing a fake login form", async () => {
        const user = userEvent.setup();
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        queryClient.setQueryData(["system", "status"], readyStatus);
        const router = createDashboardRouter(
            createMemoryHistory({ initialEntries: ["/"] })
        );
        render(<DashboardApp router={router} queryClient={queryClient} />);
        expect(await screen.findByText("Authelia remains in place.")).toBeVisible();
        await user.click(screen.getByRole("link", { name: "Identity" }));
        expect(
            await screen.findByRole("heading", {
                name: "Authentication is not implemented yet",
            })
        ).toBeVisible();
        expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
        queryClient.clear();
    });
});
