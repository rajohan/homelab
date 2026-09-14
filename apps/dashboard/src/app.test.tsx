import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConnectionStatus, createDashboardRouter, DashboardApp } from "./app";

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

afterEach(cleanup);

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
        expect(screen.getByText("Connected")).toBeTruthy();
        expect(screen.getByText("The dashboard can reach its own API.")).toBeTruthy();
        expect(screen.queryByText("All systems operational")).toBeNull();
    });

    test("shows a pending connection without claiming success", () => {
        render(<ConnectionStatus pending failed={false} onRetry={() => {}} />);
        expect(screen.getByText("Checking this application's API…")).toBeTruthy();
        expect(screen.queryByText("Connected")).toBeNull();
    });

    test("offers retry without exposing backend error details", () => {
        const retry = mock(() => {});
        render(<ConnectionStatus pending={false} failed onRetry={retry} />);
        expect(screen.getByText("Unavailable")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(retry).toHaveBeenCalledTimes(1);
    });

    test("navigates to identity without providing a fake login form", async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        queryClient.setQueryData(["system", "status"], readyStatus);
        const router = createDashboardRouter(
            createMemoryHistory({ initialEntries: ["/"] })
        );
        render(<DashboardApp router={router} queryClient={queryClient} />);
        expect(await screen.findByText("Authelia remains in place.")).toBeTruthy();
        fireEvent.click(screen.getByRole("link", { name: "Identity" }));
        expect(
            await screen.findByRole("heading", {
                name: "Authentication is not implemented yet",
            })
        ).toBeTruthy();
        expect(screen.queryByLabelText(/password/i)).toBeNull();
        queryClient.clear();
    });
});
