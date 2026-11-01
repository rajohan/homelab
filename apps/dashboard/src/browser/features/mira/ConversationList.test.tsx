import { expect, spyOn, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { deserialize, serialize } from "superjson";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { ConversationList } from "./ConversationList";

test("live conversation refresh does not repoll loaded history pages", async () => {
    const now = new Date().toISOString();
    const first = { id: crypto.randomUUID(), title: "First chat", updatedAt: now };
    const second = { id: crypto.randomUUID(), title: "Second chat", updatedAt: now };
    const third = { id: crypto.randomUUID(), title: "Third chat", updatedAt: now };
    const fourth = { id: crypto.randomUUID(), title: "New from Windows", updatedAt: now };
    let newer = false;
    const cursors: (string | undefined)[] = [];
    const wire = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (input: Parameters<typeof fetch>[0]) => {
                if (typeof input !== "string") throw new Error("Expected fixture URL");
                const url = new URL(input, "https://fixture.example.test");
                const values = JSON.parse(url.searchParams.get("input")!) as Record<
                    string,
                    ReturnType<typeof serialize>
                >;
                return Promise.resolve(
                    Response.json(
                        Object.values(values).map((value) => {
                            const query = deserialize<{ before?: { id: string } }>(value);
                            cursors.push(query.before?.id);
                            let rows = newer ? [fourth, first] : [first];
                            let next: typeof first | null = first;
                            if (query.before?.id === first.id) {
                                rows = [second];
                                next = second;
                            }
                            if (query.before?.id === second.id) {
                                rows = [third];
                                next = null;
                            }
                            return {
                                result: {
                                    data: serialize({
                                        rows,
                                        nextCursor: next
                                            ? { id: next.id, updatedAt: now }
                                            : null,
                                    }),
                                },
                            };
                        })
                    )
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const identity = new IdentityClient();
    const router = createRouter({
        routeTree: createRootRoute({ component: () => <ConversationList /> }),
        history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <RouterProvider router={router} />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    try {
        expect(await screen.findByRole("link", { name: /First chat/ })).toBeVisible();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Load more" }));
        expect(await screen.findByRole("link", { name: /Second chat/ })).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Load more" }));
        expect(await screen.findByRole("link", { name: /Third chat/ })).toBeVisible();
        newer = true;
        await waitFor(
            () =>
                expect(
                    screen.getByRole("link", { name: /New from Windows/ })
                ).toBeVisible(),
            { timeout: 6500 }
        );
        expect(screen.getAllByRole("link", { name: /First chat/ })).toHaveLength(1);
        expect(screen.getByRole("link", { name: /Third chat/ })).toBeVisible();
        expect(cursors.filter((cursor) => cursor === first.id)).toHaveLength(1);
        expect(cursors.filter((cursor) => cursor === second.id)).toHaveLength(1);
    } finally {
        view.unmount();
        query.clear();
        identity.cancelActions();
        wire.mockRestore();
    }
}, 10_000);
