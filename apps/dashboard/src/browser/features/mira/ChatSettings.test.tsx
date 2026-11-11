import { expect, spyOn, test } from "bun:test";

import { miraDefaultChatSettings } from "@homelab/contracts/mira";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { serialize } from "superjson";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { ChatSettings } from "./ChatSettings";

test("an open settings draft retains its original version when background polling updates the conversation", async () => {
    const saved: unknown[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (typeof init?.body !== "string")
                    throw new Error("Expected a settings request");
                const body = JSON.parse(init.body) as { "0": { json: unknown } };
                saved.push(body["0"].json);
                return Promise.resolve(
                    Response.json([{ result: { data: serialize(null) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const query = new QueryClient();
    const identity = new IdentityClient();
    const id = crypto.randomUUID();
    const displays: boolean[] = [];
    let closed = false;
    const content = (version: number) => (
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <ChatSettings
                    id={id}
                    version={version}
                    settings={miraDefaultChatSettings}
                    models={[]}
                    defaultModel={null}
                    fresh={false}
                    display={{
                        showActivity: true,
                        keepActivity: false,
                        showTools: true,
                        expandTools: false,
                    }}
                    onDisplayChange={(next) => displays.push(next.showTools)}
                    onClose={() => {
                        closed = true;
                    }}
                />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    const view = render(content(3));
    try {
        fireEvent.click(screen.getByRole("switch", { name: "Use saved memory" }));
        fireEvent.click(screen.getByRole("switch", { name: "Show tools" }));
        expect(displays).toEqual([false]);
        expect(saved).toEqual([]);
        view.rerender(content(4));
        fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
        await waitFor(() => expect(closed).toBe(true));
        expect(saved).toEqual([
            {
                id,
                version: 3,
                settings: { ...miraDefaultChatSettings, useMemory: false },
            },
        ]);
    } finally {
        view.unmount();
        identity.cancelActions();
        query.clear();
        request.mockRestore();
    }
});
