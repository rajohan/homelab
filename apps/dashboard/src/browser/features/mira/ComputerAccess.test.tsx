import { expect, spyOn, test } from "bun:test";

import type { MiraRun } from "@homelab/contracts/mira";
import type {
    MiraComputerAccessSummary,
    MiraComputerSummary,
} from "@homelab/contracts/miraComputers";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { serialize } from "superjson";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { ComputerAccessDialog } from "./ComputerAccessDialog";
import { ComputerAccessPanel } from "./ComputerAccessPanel";
import { computerAccessLabel } from "./useComputerAccess";

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
function computer(connected = true): MiraComputerSummary {
    return {
        id: crypto.randomUUID(),
        label: connected ? "Desktop" : "Offline laptop",
        state: "paired",
        connected,
        version: 2,
        platform: "win32",
        companionVersion: "0.10.0",
        pairedAt: null,
        lastSeenAt: null,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
}
function grant(current: MiraRun, pc: MiraComputerSummary): MiraComputerAccessSummary {
    return {
        id: crypto.randomUUID(),
        computerId: pc.id,
        runId: current.id,
        mode: "view",
        state: "active",
        expiresAt: pc.expiresAt,
    };
}
const accessKey = (id: string) => ["operations", "mira", "computer-access", id];
const computersKey = ["operations", "mira", "computers"];
function fixture(
    current: MiraRun,
    pcs: MiraComputerSummary[],
    grants: MiraComputerAccessSummary[],
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
    query.setQueryData(computersKey, pcs);
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

test("computer request defaults to view and submits the displayed PC version only after an explicit choice", async () => {
    const current = run();
    const pc = computer();
    const wire = network(true);
    const f = fixture(
        current,
        [pc, computer(false)],
        [],
        <ComputerAccessDialog run={current} supportsImages onClose={() => {}} />
    );
    try {
        const user = userEvent.setup();
        expect(screen.getByRole("button", { name: "Request access" })).toBeDisabled();
        expect(
            screen.getByRole("button", { name: /Computer permission/ })
        ).toHaveTextContent("View only");
        await user.click(screen.getByRole("button", { name: /^Computer Computer$/ }));
        expect(
            screen.queryByRole("option", { name: "Offline laptop" })
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole("option", { name: "Desktop" }));
        await user.click(screen.getByRole("button", { name: "Request access" }));
        await screen.findByRole("alert");
        expect(wire.sent).toHaveLength(1);
        expect(wire.sent[0]!.url).toContain("mira.computers.access.request");
        expect(wire.sent[0]!.body).toEqual({
            "0": {
                json: {
                    computerId: pc.id,
                    computerVersion: 2,
                    runId: current.id,
                    mode: "view",
                },
            },
        });
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        act(() => {
            f.query.setQueryData(accessKey(current.id), [
                { ...grant(current, pc), state: "pending" },
            ]);
        });
        expect(await screen.findByText("Awaiting local approval")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Request access" })
        ).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
        expect(wire.sent).toHaveLength(1);
    } finally {
        f.close();
        wire.close();
    }
});

test("a changed PC version clears the selection and ended, automatic or text-only runs cannot request access", async () => {
    const current = run();
    const pc = computer();
    const f = fixture(
        current,
        [pc],
        [],
        <ComputerAccessDialog run={current} supportsImages onClose={() => {}} />
    );
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /^Computer Computer$/ }));
        await user.click(screen.getByRole("option", { name: "Desktop" }));
        expect(screen.getByRole("button", { name: "Request access" })).toBeEnabled();
        act(() => {
            f.query.setQueryData(computersKey, [{ ...pc, version: 3 }]);
        });
        await waitFor(() =>
            expect(screen.getByRole("button", { name: "Request access" })).toBeDisabled()
        );
        expect(
            screen.getByRole("button", { name: /^Computer Computer$/ })
        ).toHaveTextContent("Choose a connected computer");
        await user.click(screen.getByRole("button", { name: /^Computer Computer$/ }));
        await user.click(screen.getByRole("option", { name: "Desktop" }));
        f.rerender(
            <ComputerAccessDialog
                run={current}
                supportsImages={false}
                onClose={() => {}}
            />
        );
        expect(screen.getByRole("button", { name: "Request access" })).toBeDisabled();
        expect(screen.getByText(/model with image support/)).toBeInTheDocument();
        for (const ended of [
            { ...current, state: "completed" as const },
            { ...current, cancelRequested: true },
            { ...current, automationId: crypto.randomUUID() },
        ]) {
            f.rerender(
                <ComputerAccessDialog run={ended} supportsImages onClose={() => {}} />
            );
            expect(
                screen.queryByRole("button", { name: "Request access" })
            ).not.toBeInTheDocument();
        }
    } finally {
        f.close();
    }
});

test("stale or failed reads never advertise control but preserve the exact direct stop action", async () => {
    const current = run();
    const pc = computer();
    const access = grant(current, pc);
    const wire = network(true);
    const f = fixture(
        current,
        [pc],
        [access],
        <ComputerAccessPanel run={current} waiting={false} onManage={() => {}} />,
        10_000
    );
    try {
        expect(screen.getByText("Status unavailable")).toBeInTheDocument();
        const cached = f.query.getQueryCache().find({ queryKey: accessKey(current.id) });
        act(() => {
            cached!.setState({
                error: new Error("Synthetic status unavailable"),
                status: "error",
            });
        });
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Stop access" }));
        await screen.findByRole("alert");
        expect(wire.sent).toHaveLength(1);
        expect(wire.sent[0]!.url).toContain("mira.computers.access.stop");
        expect(wire.sent[0]!.body).toEqual({ "0": { json: { id: access.id } } });
        expect(screen.getByRole("button", { name: "Stop access" })).toBeEnabled();
    } finally {
        f.close();
        wire.close();
    }
});

test("pending access remains visible after the run ends, and switching runs never carries its status forward", () => {
    const current = run();
    const next = run();
    const pc = computer();
    const access = { ...grant(current, pc), state: "pending" as const };
    const f = fixture(
        current,
        [pc],
        [access],
        <ComputerAccessPanel run={current} waiting={false} onManage={() => {}} />
    );
    try {
        expect(screen.getByText("Awaiting local approval")).toBeInTheDocument();
        f.rerender(
            <ComputerAccessPanel
                run={{ ...current, state: "completed" }}
                waiting={false}
                onManage={() => {}}
            />
        );
        expect(screen.getByText("Unavailable")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Stop access" })).toBeInTheDocument();
        f.query.setQueryData(accessKey(next.id), []);
        f.rerender(<ComputerAccessPanel run={next} waiting onManage={() => {}} />);
        expect(screen.getByText("Not shared")).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Stop access" })
        ).not.toBeInTheDocument();
        f.rerender(
            <ComputerAccessPanel run={next} waiting={false} onManage={() => {}} />
        );
        expect(
            screen.queryByRole("region", { name: "Computer access status" })
        ).not.toBeInTheDocument();
    } finally {
        f.close();
    }
});

test("readiness labels preserve expiry, stop, unavailable and selected scope", () => {
    const current = run();
    const access = grant(current, computer());
    expect(computerAccessLabel(access, current, true)).toBe("View only");
    expect(computerAccessLabel({ ...access, mode: "control" }, current, true)).toBe(
        "Control"
    );
    for (const state of ["stopped", "expired", "unavailable"] as const)
        expect(computerAccessLabel({ ...access, state }, current, true)).toBe(
            state[0]!.toUpperCase() + state.slice(1)
        );
});
