import { expect, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { AutomationAccess } from "./AutomationAccess";

test("an initial automation failure has one error and retry control, cleared after recovery", async () => {
    const identity = new IdentityClient();
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const queryKey = ["operations", "automation"];
    const failure = new Error("Automation accounts could not be loaded.");
    const result = await query
        .fetchQuery({
            queryKey,
            queryFn: () => Promise.reject(failure),
        })
        .catch((error: unknown) => error);
    expect(result).toBe(failure);
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <AutomationAccess />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    try {
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        expect(screen.getByRole("alert")).toHaveTextContent(failure.message);
        expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(1);
        expect(screen.queryByText(/No automation accounts/)).not.toBeInTheDocument();

        act(() => {
            query.setQueryData(queryKey, {
                pages: [{ accounts: [], credentials: [], nextCursor: null }],
                pageParams: [undefined],
            });
        });
        await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
        expect(
            screen.queryByRole("button", { name: "Try again" })
        ).not.toBeInTheDocument();
        expect(screen.getByText(/No automation accounts/)).toBeVisible();
    } finally {
        view.unmount();
        identity.cancelActions();
        query.clear();
    }
});
