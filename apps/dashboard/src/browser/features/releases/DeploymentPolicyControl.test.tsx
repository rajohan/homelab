import { expect, test } from "bun:test";

import type { DeploymentPolicySummary } from "@homelab/contracts/deployment";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { DeploymentPolicyControl } from "./DeploymentPolicyControl";

const policy: DeploymentPolicySummary = {
    target: "main",
    version: 1,
    mode: "patch",
    window: { start: "03:00", minutes: 60 },
    timeZone: "Europe/Oslo",
    paused: false,
    reason: null,
    until: null,
    configurationChanged: false,
};
function fixture(change: Partial<DeploymentPolicySummary> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={client}>
            <IdentityClientContext value={new IdentityClient()}>
                <DeploymentPolicyControl policy={{ ...policy, ...change }} />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    return () => {
        cleanup();
        client.clear();
    };
}

test("deployment policy editor offers manual and bounded stable scopes using shared time controls", async () => {
    const close = fixture({ mode: "manual", version: 0 });
    try {
        expect(
            screen.queryByRole("button", { name: "Pause deployment" })
        ).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Edit policy" }));
        const dialog = screen.getByRole("dialog", { name: "Deployment policy" });
        expect(
            within(dialog).queryByRole("button", { name: "Daily window starts, hour" })
        ).not.toBeInTheDocument();
        await userEvent.click(within(dialog).getByRole("button", { name: "Updates" }));
        await userEvent.click(
            screen.getByRole("option", { name: "Automatic patch and minor releases" })
        );
        expect(
            within(dialog).getByRole("button", { name: "Daily window starts, hour" })
        ).toHaveTextContent("03");
        expect(
            within(dialog).getByText(/Major releases and database changes/)
        ).toBeVisible();
        await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
        close();
    }
});

test("deployment pause requires a reason and supports explicit timed resumption", async () => {
    const close = fixture();
    try {
        await userEvent.click(screen.getByRole("button", { name: "Pause deployment" }));
        const dialog = screen.getByRole("dialog", { name: "Pause deployment" });
        await userEvent.click(
            within(dialog).getByRole("button", { name: "Pause deployment" })
        );
        expect(screen.getByLabelText("Reason")).toHaveAttribute("aria-invalid", "true");
        await userEvent.type(screen.getByLabelText("Reason"), "Scheduled maintenance");
        await userEvent.click(
            screen.getByRole("switch", { name: "Resume automatically" })
        );
        expect(screen.getByRole("group", { name: "Resume at" })).toBeVisible();
        await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
        close();
    }
});

test("paused policies show their reason and retain the pause while editing", async () => {
    const close = fixture({
        paused: true,
        reason: "Travel",
        until: Date.now() + 3_600_000,
    });
    try {
        expect(screen.getByText(/Travel/)).toBeVisible();
        expect(screen.getByRole("button", { name: "Resume deployment" })).toBeEnabled();
        await userEvent.click(screen.getByRole("button", { name: "Edit policy" }));
        expect(
            screen.getByText("This policy stays paused until you resume it.")
        ).toBeVisible();
    } finally {
        close();
    }
});

test("configuration drift is visible and needs a new policy save", () => {
    const close = fixture({ configurationChanged: true });
    try {
        expect(screen.getByText("Review policy")).toBeVisible();
        expect(screen.getByText(/Configuration changed/)).toBeVisible();
    } finally {
        close();
    }
});
