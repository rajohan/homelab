import { expect, spyOn, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { serialize } from "superjson";

import { intersectionFixture } from "../../../../../../tests/intersectionFixture";
import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { CodeLibrary } from "./CodeLibrary";
import { DaytonaJobs } from "./DaytonaJobs";

for (const [key, Library] of [
    ["code", CodeLibrary],
    ["daytona", DaytonaJobs],
] as const) {
    test(`${key} history observes its inner list and waits for scrolling between pages`, async () => {
        const intersection = intersectionFixture();
        const query = new QueryClient({
            defaultOptions: { queries: { enabled: false, retry: false } },
        });
        const identity = new IdentityClient();
        const queryKey = ["operations", "mira", key, undefined];
        query.setQueryData(queryKey, {
            pages: [{ rows: [], nextCursor: "page-two" }],
            pageParams: [undefined],
        });
        const wire = spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(
                () =>
                    Promise.resolve(
                        Response.json([
                            {
                                result: {
                                    data: serialize({
                                        rows: [],
                                        nextCursor: "page-three",
                                    }),
                                },
                            },
                        ])
                    ),
                { preconnect: fetch.preconnect }
            )
        );
        const view = render(
            <QueryClientProvider client={query}>
                <IdentityClientContext value={identity}>
                    <Library />
                </IdentityClientContext>
            </QueryClientProvider>,
            { container: intersection.container }
        );
        try {
            const observed = intersection.observed();
            expect(observed).toHaveLength(1);
            const { element, root } = observed[0]!;
            expect(root).not.toBeNull();
            expect(root).toHaveClass("overflow-y-auto");
            expect(root!.contains(element)).toBe(true);
            act(() => intersection.intersect(false));
            expect(wire).not.toHaveBeenCalled();
            act(() => intersection.intersect());
            await waitFor(() =>
                expect(
                    query.getQueryData<{ pages: unknown[] }>(queryKey)?.pages
                ).toHaveLength(2)
            );
            act(() => intersection.intersect(false));
            expect(wire).toHaveBeenCalledTimes(1);
        } finally {
            view.unmount();
            query.clear();
            identity.cancelActions();
            wire.mockRestore();
            intersection.close();
        }
    });
}
