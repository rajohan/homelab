import { expect, spyOn, test } from "bun:test";

import type { MiraRun } from "@homelab/contracts/mira";
import type { MiraBrowserAccessSummary } from "@homelab/contracts/miraBrowser";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { serialize } from "superjson";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { BrowserAccessDialog } from "./BrowserAccessDialog";
import { BrowserAccessPanel } from "./BrowserAccessPanel";

function run(): MiraRun {
    return {
        id: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        taskId: null,
        automationId: null,
        state: "running",
        cancelRequested: false,
        message: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
    };
}
function grant(current: MiraRun): MiraBrowserAccessSummary {
    return {
        id: crypto.randomUUID(),
        runId: current.id,
        state: "active",
        mode: "view",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        origins: ["https://example.test"],
        initialUrl: "https://example.test/page",
    };
}
const accessKey = (id: string) => ["operations", "mira", "browser-access", id];
const controlsKey = ["operations", "mira", "controls"];
function fixture(
    current: MiraRun,
    grants: MiraBrowserAccessSummary[],
    content: ReactNode,
    age = 0
) {
    const query = new QueryClient({
        defaultOptions: {
            queries: {
                enabled: false,
                retry: false,
                staleTime: Infinity,
                refetchOnMount: false,
            },
        },
    });
    query.setQueryData(controlsKey, [{ key: "computer:browser", enabled: true }]);
    query.setQueryData(accessKey(current.id), grants, { updatedAt: Date.now() - age });
    const identity = new IdentityClient();
    const wrap = (children: ReactNode) => (
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>{children}</IdentityClientContext>
        </QueryClientProvider>
    );
    const view = render(wrap(content));
    return {
        query,
        rerender: (children: ReactNode) => view.rerender(wrap(children)),
        close: () => {
            view.unmount();
            identity.cancelActions();
            query.clear();
        },
    };
}
function network(fail = false) {
    const sent: { url: string; body: unknown }[] = [];
    const spy = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (init?.method !== "POST")
                    return Promise.resolve(
                        Response.json([{ result: { data: serialize([]) } }])
                    );
                if (typeof init.body !== "string")
                    throw new Error("Expected synthetic JSON");
                if (typeof url !== "string")
                    throw new Error("Expected a synthetic URL string");
                sent.push({ url, body: JSON.parse(init.body) as unknown });
                return fail
                    ? Promise.reject(new Error("Synthetic connection interrupted"))
                    : Promise.resolve(
                          Response.json([
                              { result: { data: serialize({ stopped: true }) } },
                          ])
                      );
            },
            { preconnect: fetch.preconnect }
        )
    );
    return { sent, close: () => spy.mockRestore() };
}

test("browser access defaults to view and submits only the explicitly approved origins and current run", async () => {
    const current = run(),
        wire = network(true);
    const f = fixture(
        current,
        [],
        <BrowserAccessDialog run={current} supportsImages onClose={() => {}} />
    );
    try {
        const user = userEvent.setup();
        expect(wire.sent).toHaveLength(0);
        expect(
            screen.getByRole("button", { name: /Browser permission/ })
        ).toHaveTextContent("View only");
        await user.type(
            screen.getByRole("textbox", { name: "Starting URL" }),
            "https://example.test/page"
        );
        await user.type(
            screen.getByRole("textbox", { name: /Other allowed origins/ }),
            "https://extra.test\nhttps://extra.test"
        );
        await user.click(screen.getByRole("button", { name: "Allow browser" }));
        await screen.findByRole("alert");
        expect(wire.sent).toHaveLength(1);
        expect(wire.sent[0]!.url).toContain("mira.browser.request");
        expect(wire.sent[0]!.body).toEqual({
            "0": {
                json: {
                    runId: current.id,
                    origins: ["https://example.test", "https://extra.test"],
                    initialUrl: "https://example.test/page",
                    mode: "view",
                },
            },
        });
        act(() => {
            f.query.setQueryData(accessKey(current.id), [
                { ...grant(current), state: "pending" },
            ]);
        });
        expect(await screen.findByText("Ready to start")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Allow browser" })
        ).not.toBeInTheDocument();
    } finally {
        f.close();
        wire.close();
    }
});

test("stale, paused and text-only states cannot grant browser access", async () => {
    const current = run();
    const f = fixture(
        current,
        [],
        <BrowserAccessDialog run={current} supportsImages onClose={() => {}} />,
        10_000
    );
    try {
        expect(screen.getByRole("button", { name: "Allow browser" })).toBeDisabled();
        act(() => {
            f.query.setQueryData(accessKey(current.id), []);
            f.query.setQueryData(controlsKey, [
                { key: "computer:browser", enabled: false },
            ]);
        });
        await screen.findByText(/Browser access is paused/);
        expect(screen.getByRole("button", { name: "Allow browser" })).toBeDisabled();
        act(() => {
            f.query.setQueryData(controlsKey, [
                { key: "computer:browser", enabled: true },
            ]);
        });
        f.rerender(
            <BrowserAccessDialog
                run={current}
                supportsImages={false}
                onClose={() => {}}
            />
        );
        expect(screen.getByRole("button", { name: "Allow browser" })).toBeDisabled();
        for (const ended of [
            { ...current, state: "completed" as const },
            { ...current, cancelRequested: true },
            { ...current, automationId: crypto.randomUUID() },
        ]) {
            f.rerender(
                <BrowserAccessDialog run={ended} supportsImages onClose={() => {}} />
            );
            expect(
                screen.queryByRole("button", { name: "Allow browser" })
            ).not.toBeInTheDocument();
        }
    } finally {
        f.close();
    }
});

test("stale browser status preserves the exact direct stop action outside the dialog", async () => {
    const current = run(),
        access = grant(current),
        wire = network(true);
    const f = fixture(
        current,
        [access],
        <BrowserAccessPanel run={current} waiting={false} onManage={() => {}} />,
        10_000
    );
    try {
        expect(screen.getByText("Status unavailable")).toBeInTheDocument();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Stop access" }));
        await screen.findByRole("alert");
        expect(wire.sent[0]!.url).toContain("mira.browser.stop");
        expect(wire.sent[0]!.body).toEqual({ "0": { json: { id: access.id } } });
        act(() => {
            f.query.setQueryData(accessKey(current.id), [{ ...access, state: "closed" }]);
        });
        await waitFor(() =>
            expect(
                screen.queryByRole("region", { name: "Browser access status" })
            ).not.toBeInTheDocument()
        );
    } finally {
        f.close();
        wire.close();
    }
});
