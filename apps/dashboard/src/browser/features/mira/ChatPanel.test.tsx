import { afterAll, beforeAll, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { ChatPanel as SourceChatPanel } from "./ChatPanel";

const compiledPath = `${import.meta.dir}/.ChatPanel-${crypto.randomUUID()}.js`;
let CompiledChatPanel: typeof SourceChatPanel;

beforeAll(async () => {
    // Exercise production compiler dependency hoisting, not just the source JSX.
    const build = await Bun.build({
        entrypoints: [`${import.meta.dir}/ChatPanel.tsx`],
        target: "bun",
        reactCompiler: true,
        reactCompilerOutputMode: "client",
        external: ["*"],
    });
    if (!build.success || !build.outputs[0])
        throw new Error("The compiled chat regression fixture could not build.");
    await Bun.write(compiledPath, build.outputs[0]);
    ({ ChatPanel: CompiledChatPanel } = (await import(compiledPath)) as {
        ChatPanel: typeof SourceChatPanel;
    });
});

afterAll(async () => {
    await unlink(compiledPath).catch(() => {});
});

test.each([
    ["source", "loaded"],
    ["source", "failed"],
    ["compiled", "loaded"],
    ["compiled", "failed"],
] as const)("%s chat survives the pending-to-%s transition", async (mode, outcome) => {
    const ChatPanel = mode === "compiled" ? CompiledChatPanel : SourceChatPanel;
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const identity = new IdentityClient();
    const id = crypto.randomUUID();
    const key = ["operations", "mira", "conversation", id, undefined];
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => (
                <ChatPanel id={id} onChooseConversation={() => {}} onLibrary={() => {}} />
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
            await screen.findByRole("status", { name: "Loading conversation…" })
        ).toBeVisible();
        act(() => {
            if (outcome === "failed") {
                query
                    .getQueryCache()
                    .find({ queryKey: key })
                    ?.setState({
                        status: "error",
                        error: new Error("Synthetic conversation failure"),
                    });
            } else {
                query.setQueryData(key, {
                    conversation: {
                        id,
                        title: "Compiled conversation",
                        version: 3,
                        archivedAt: null,
                    },
                    messages: [],
                    run: null,
                    tools: [],
                    nextCursor: null,
                });
            }
        });
        if (outcome === "failed")
            expect(await screen.findByRole("alert")).toHaveTextContent(
                "Synthetic conversation failure"
            );
        else
            expect(
                await screen.findByRole("heading", { name: "Compiled conversation" })
            ).toBeVisible();
        expect(screen.queryByText("This view couldn't load")).not.toBeInTheDocument();
    } finally {
        view.unmount();
        identity.cancelActions();
        query.clear();
        router.history.destroy();
    }
});
