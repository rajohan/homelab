import { expect, test } from "bun:test";

import type { MiraTask } from "@homelab/contracts/mira";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { TaskDetail } from "./TaskDetail";

test("open task details adopt background starts before opening the editor", async () => {
    const task: MiraTask = {
        id: crypto.randomUUID(),
        version: 1,
        title: "Automatic task",
        description: "Synthetic task",
        status: "todo",
        assignee: "mira",
        priority: "normal",
        labels: [],
        dueAt: null,
        completionCriteria: "Verified",
        conversationId: null,
        autoStart: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const identity = new IdentityClient();
    let edited: MiraTask | undefined;
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => (
                <TaskDetail
                    task={task}
                    onClose={() => {}}
                    onEdit={(value) => {
                        edited = value;
                    }}
                />
            ),
        }),
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
        expect(
            screen.queryByRole("link", { name: "Open conversation" })
        ).not.toBeInTheDocument();
        const started = { ...task, version: 2, conversationId: crypto.randomUUID() };
        act(() => {
            query.setQueryData(
                ["operations", "mira", "task", task.id, "detail"],
                started
            );
        });
        await waitFor(() =>
            expect(
                screen.getByRole("link", { name: "Open conversation" })
            ).toHaveAttribute("href", `/mira/${started.conversationId}`)
        );
        await userEvent.setup().click(screen.getByRole("button", { name: "Edit task" }));
        expect(edited).toEqual(started);
    } finally {
        view.unmount();
        query.clear();
        identity.cancelActions();
        router.history.destroy();
    }
});
