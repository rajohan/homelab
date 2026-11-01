import { afterEach, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { hasDesktopBridge, requestDesktop, type DesktopState } from "./desktopClient";
import { DesktopComputer } from "./DesktopComputer";

const initial: DesktopState = {
    message: "Connected",
    computerId: "12345678-1234-4234-8234-123456789abc",
    busy: true,
    canStart: false,
    canStop: true,
    canUpdate: false,
};
const original = Object.getOwnPropertyDescriptor(globalThis, "chrome");
afterEach(() => {
    if (original) Object.defineProperty(globalThis, "chrome", original);
    else Reflect.deleteProperty(globalThis, "chrome");
});
function host(reply = true) {
    const listeners = new Set<(event: MessageEvent<unknown>) => void>();
    const requests: Record<string, unknown>[] = [];
    let state = initial;
    Object.defineProperty(globalThis, "chrome", {
        configurable: true,
        value: {
            webview: {
                postMessage(value: Record<string, unknown>) {
                    requests.push(value);
                    if (value.action === "stop")
                        state = {
                            ...state,
                            message: "Disconnected",
                            busy: false,
                            canStart: true,
                            canStop: false,
                            canUpdate: true,
                        };
                    if (value.action === "forget")
                        state = {
                            ...state,
                            computerId: null,
                            message: "Local pairing removed.",
                        };
                    if (reply)
                        queueMicrotask(() => {
                            for (const listener of listeners)
                                listener(
                                    new MessageEvent("message", {
                                        data: {
                                            type: "mira-desktop",
                                            protocol: 1,
                                            error: null,
                                            id: value.id,
                                            state,
                                        },
                                    })
                                );
                        });
                },
                addEventListener(
                    _name: string,
                    listener: (event: MessageEvent<unknown>) => void
                ) {
                    listeners.add(listener);
                },
                removeEventListener(
                    _name: string,
                    listener: (event: MessageEvent<unknown>) => void
                ) {
                    listeners.delete(listener);
                },
            },
        },
    });
    return { requests, listeners };
}

test("ordinary web clients keep the same Settings without Windows connection controls", () => {
    const query = new QueryClient();
    const view = render(
        <QueryClientProvider client={query}>
            <DesktopComputer />
        </QueryClientProvider>
    );
    try {
        expect(hasDesktopBridge()).toBe(false);
        expect(screen.queryByText("This Windows PC")).not.toBeInTheDocument();
    } finally {
        view.unmount();
        query.clear();
    }
});

test("Windows controls reflect local state and use fixed actions without account data", async () => {
    const native = host();
    const query = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const view = render(
        <QueryClientProvider client={query}>
            <DesktopComputer />
        </QueryClientProvider>
    );
    try {
        expect(await screen.findByText("Connected")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /^Connect$/ })).toBeDisabled();
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Stop connection" }));
        expect(await screen.findByText("Disconnected")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Update app" })).toBeEnabled();
        expect(native.requests.map((item) => item.action)).toEqual(["state", "stop"]);
        expect(Object.keys(native.requests[1]!).toSorted()).toEqual([
            "action",
            "id",
            "protocol",
            "type",
        ]);
    } finally {
        view.unmount();
        query.clear();
    }
    expect(native.listeners.size).toBe(0);
});

test("the bridge ignores unrelated and malformed replies, then releases listeners on cancellation", async () => {
    const native = host(false);
    const abort = new AbortController();
    const result = requestDesktop({ action: "state" }, abort.signal);
    let completed = false;
    void result.then(
        () => {
            completed = true;
            return null;
        },
        () => {
            completed = true;
            return null;
        }
    );
    for (const listener of native.listeners) {
        listener(
            new MessageEvent("message", {
                data: {
                    type: "mira-desktop",
                    protocol: 1,
                    error: null,
                    id: crypto.randomUUID(),
                    state: initial,
                },
            })
        );
        listener(
            new MessageEvent("message", {
                data: {
                    type: "mira-desktop",
                    protocol: 1,
                    error: null,
                    id: native.requests[0]!.id,
                    state: { ...initial, credential: "not-allowed" },
                },
            })
        );
    }
    await Promise.resolve();
    expect(completed).toBe(false);
    abort.abort();
    expect(await result.catch((error: unknown) => error)).toBeInstanceOf(Error);
    expect(native.listeners.size).toBe(0);
});

test("pairing removal waits for shared confirmation before starting a timed native request", async () => {
    const native = host();
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
        <QueryClientProvider client={query}>
            <DesktopComputer />
        </QueryClientProvider>
    );
    try {
        const user = userEvent.setup();
        await screen.findByText("Connected");
        await user.click(screen.getByRole("button", { name: "Stop connection" }));
        await screen.findByText("Disconnected");
        await user.click(screen.getByRole("button", { name: "Remove pairing" }));
        const dialog = screen.getByRole("dialog");
        expect(within(dialog).getByText("Remove this PC's pairing?")).toBeInTheDocument();
        expect(
            native.requests.filter((request) => request.action === "forget")
        ).toHaveLength(0);
        expect(native.listeners.size).toBe(0);
        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(
            native.requests.filter((request) => request.action === "forget")
        ).toHaveLength(0);
        await user.click(screen.getByRole("button", { name: "Remove pairing" }));
        await user.click(
            within(screen.getByRole("dialog")).getByRole("button", {
                name: "Remove pairing",
            })
        );
        await screen.findByText("Local pairing removed.");
        expect(
            native.requests.filter((request) => request.action === "forget")
        ).toHaveLength(1);
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
        view.unmount();
        query.clear();
    }
});

test("pairing sends the one-use code once and does not retry after cancellation", async () => {
    const native = host(false),
        abort = new AbortController();
    const result = requestDesktop(
        { action: "pair", ticket: "synthetic-ticket" },
        abort.signal
    );
    abort.abort();
    expect(await result.catch((error: unknown) => error)).toBeInstanceOf(Error);
    await waitFor(() => expect(native.requests).toHaveLength(1));
    expect(native.requests[0]?.ticket).toBe("synthetic-ticket");
});
