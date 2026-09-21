import { expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { useJobCompletionRefresh } from "./useJobCompletionRefresh";

test("update completions refresh source summaries and software pages once, including failed partial updates", () => {
    const client = new QueryClient();
    const key = ["operations", "updates", "main"];
    client.setQueryData(key, "before");
    const run = {
        id: "one",
        action: "updates.install.demo",
        finishedAt: null as string | null,
    };
    const view = renderHook(({ runs }) => useJobCompletionRefresh(runs), {
        initialProps: { runs: [run] },
        wrapper: ({ children }: { readonly children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
    });
    try {
        expect(client.getQueryState(key)?.isInvalidated).toBe(false);
        view.rerender({ runs: [{ ...run, finishedAt: "2026-09-21T12:00:00Z" }] });
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
        client.setQueryData(key, "after");
        view.rerender({ runs: [{ ...run, finishedAt: "2026-09-21T12:00:00Z" }] });
        expect(client.getQueryState(key)?.isInvalidated).toBe(false);
        view.rerender({
            runs: [{ ...run, id: "two", finishedAt: "2026-09-21T12:01:00Z" }],
        });
        expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    } finally {
        view.unmount();
        client.clear();
    }
});
