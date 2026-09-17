import { expect, mock, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { AutomationAccountCard } from "./AutomationAccountCard";
import { AutomationEditor } from "./AutomationEditor";

test("automation creation requires an explicit scope and cancellation never issues a token", async () => {
    const identity = new IdentityClient();
    const query = new QueryClient();
    const close = mock(() => {});
    const token = mock((_value: string) => {});
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <AutomationEditor onClose={close} onToken={token} />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    try {
        const user = userEvent.setup();
        const submit = screen.getByRole("button", { name: "Create account" });
        expect(submit).toBeDisabled();
        await user.type(
            screen.getByRole("textbox", { name: "Account name" }),
            "Test client"
        );
        expect(submit).toBeDisabled();
        await user.click(screen.getByRole("switch", { name: "View job runs" }));
        await waitFor(() => expect(submit).toBeEnabled());
        expect(screen.getByRole("button", { name: "90 days" })).toHaveAttribute(
            "aria-pressed",
            "true"
        );
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(close).toHaveBeenCalledTimes(1);
        expect(token).not.toHaveBeenCalled();
    } finally {
        view.unmount();
        identity.cancelActions();
        query.clear();
    }
});

test("disabled automation accounts have no credential or permission mutation controls", () => {
    render(
        <AutomationAccountCard
            account={{
                id: "019959a7-4600-7000-8000-000000000001",
                label: "Retired client",
                capabilities: ["jobs:read"],
                version: 2,
                createdAt: "2026-09-01T00:00:00Z",
                disabledAt: "2026-09-02T00:00:00Z",
            }}
            credentials={[]}
            onEdit={() => {}}
            onAction={() => {}}
        />
    );
    expect(screen.getByText("Disabled")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

test("a wrapped revoke action grows to the credential row width", async () => {
    const onAction = mock(() => {});
    const account = {
        id: "019959a7-4600-7000-8000-000000000001",
        label: "Preview client",
        capabilities: ["jobs:read" as const],
        version: 1,
        createdAt: "2026-09-01T00:00:00Z",
        disabledAt: null,
    };
    const credential = {
        id: "019959a7-4600-7000-8000-000000000002",
        accountId: account.id,
        prefix: "test-token-prefix",
        createdAt: "2026-09-01T00:00:00Z",
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
    };
    const view = render(
        <AutomationAccountCard
            account={account}
            credentials={[credential]}
            onEdit={() => {}}
            onAction={onAction}
        />
    );
    try {
        const button = screen.getByRole("button", { name: "Revoke token" });
        expect(button).toHaveClass("grow", "basis-32");
        await userEvent.setup().click(button);
        expect(onAction).toHaveBeenCalledWith({ kind: "revoke", account, credential });
    } finally {
        view.unmount();
    }
});
