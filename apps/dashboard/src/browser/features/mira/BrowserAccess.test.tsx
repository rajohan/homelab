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
import { BrowserConsoleDialog } from "./BrowserConsoleDialog";
import { BrowserPageControls } from "./BrowserPageControls";
import { BrowserUploadControls } from "./BrowserUploadControls";

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

function preview() {
    return {
        observationId: crypto.randomUUID(),
        url: "https://example.test/page",
        title: "Synthetic browser page",
        refs: [
            {
                ref: "p1:1",
                role: "textbox",
                label: "Synthetic field",
                actions: ["type" as const, "click" as const],
            },
        ],
        width: 64,
        height: 64,
        image: "synthetic",
        observedAt: new Date().toISOString(),
    };
}

test("browser console shows bounded images and sends private input outside mutation storage", async () => {
    const current = run(),
        access = { ...grant(current), mode: "control" as const };
    const f = fixture(current, [access], null);
    const view = preview(),
        epoch = crypto.randomUUID();
    f.query.setQueryData(["operations", "mira", "browser-console", access.id], {
        epoch,
        controller: "human",
        busy: false,
        preview: view,
    });
    const wire = network();
    try {
        f.rerender(<BrowserConsoleDialog access={access} onClose={() => {}} />);
        expect(
            screen.getByRole("img", {
                name: "Latest view of the isolated server browser",
            })
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Return to Mira" })
        ).toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /^Page element/ }));
        await user.click(
            await screen.findByRole("option", { name: "textbox: Synthetic field" })
        );
        await user.type(
            screen.getByLabelText("Text to enter"),
            "synthetic private value"
        );
        await user.click(screen.getByRole("button", { name: "Enter text" }));
        await waitFor(() => expect(wire.sent).toHaveLength(1));
        expect(wire.sent[0]!.url).toContain("mira.browser.command");
        expect(JSON.stringify(wire.sent[0]!.body)).toContain("synthetic private value");
        expect(screen.getByLabelText("Text to enter")).toHaveValue("");
        expect(f.query.getMutationCache().getAll()).toHaveLength(0);
    } finally {
        f.close();
        wire.close();
    }
});

test("private typing draft survives a refreshed observation while stale actions stay disabled", async () => {
    const first = preview();
    const sent: unknown[] = [];
    const view = render(
        <BrowserPageControls
            preview={first}
            disabled
            onCommand={(input) => sent.push(input)}
        />
    );
    try {
        const user = userEvent.setup();
        await user.type(screen.getByLabelText("Text to enter"), "synthetic draft");
        view.rerender(
            <BrowserPageControls
                preview={null}
                disabled
                onCommand={(input) => sent.push(input)}
            />
        );
        expect(screen.getByLabelText("Text to enter")).toHaveValue("synthetic draft");
        const next = { ...preview(), refs: [{ ...first.refs[0]!, ref: "p2:1" }] };
        view.rerender(
            <BrowserPageControls
                preview={next}
                disabled={false}
                onCommand={(input) => sent.push(input)}
            />
        );
        await user.click(screen.getByRole("button", { name: /^Page element/ }));
        await user.click(
            await screen.findByRole("option", { name: "textbox: Synthetic field" })
        );
        await user.click(screen.getByRole("button", { name: "Enter text" }));
        expect(sent).toEqual([
            {
                method: "act",
                input: {
                    action: "type",
                    observationId: next.observationId,
                    ref: "p2:1",
                    text: "synthetic draft",
                    replace: true,
                },
            },
        ]);
    } finally {
        view.unmount();
    }
});

test("stale browser status hides pixels and disables takeover without hiding stop", () => {
    const current = run(),
        access = grant(current);
    const f = fixture(current, [access], null);
    f.query.setQueryData(
        ["operations", "mira", "browser-console", access.id],
        {
            epoch: crypto.randomUUID(),
            controller: "mira",
            busy: false,
            preview: preview(),
        },
        { updatedAt: Date.now() - 10_000 }
    );
    try {
        f.rerender(<BrowserConsoleDialog access={access} onClose={() => {}} />);
        expect(screen.queryByRole("img")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Take control" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Stop access" })).toBeEnabled();
        expect(
            screen.getByRole("region", { name: "Server browser content" })
        ).toHaveClass("overflow-y-auto");
    } finally {
        f.close();
    }
});

test("saved browser profiles populate only their approved origins and cannot be granted while busy", async () => {
    const current = run(),
        wire = network(true);
    const f = fixture(
        current,
        [],
        <BrowserAccessDialog run={current} supportsImages onClose={() => {}} />
    );
    const profile = {
        id: crypto.randomUUID(),
        name: "My websites",
        origins: ["https://example.test", "https://login.test"],
        state: "active",
        busy: false,
        createdAt: new Date().toISOString(),
    };
    const key = ["operations", "mira", "browser-profiles"];
    try {
        act(() => {
            f.query.setQueryData(key, [profile]);
        });
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: /Browser profile/ }));
        await user.click(screen.getByRole("option", { name: "My websites" }));
        expect(screen.getByRole("textbox", { name: "Starting URL" })).toHaveValue(
            "https://example.test"
        );
        expect(
            screen.getByRole("textbox", { name: /Other allowed origins/ })
        ).toHaveValue("https://login.test");
        act(() => {
            f.query.setQueryData(key, [{ ...profile, busy: true }]);
        });
        await waitFor(() =>
            expect(
                screen.getByRole<HTMLButtonElement>("button", { name: "Allow browser" })
                    .disabled
            ).toBe(true)
        );
        await waitFor(() =>
            expect(
                screen.getByRole<HTMLButtonElement>("button", { name: "Delete profile" })
                    .disabled
            ).toBe(true)
        );
        act(() => {
            f.query.setQueryData(key, [profile]);
        });
        await waitFor(() =>
            expect(
                screen.getByRole<HTMLButtonElement>("button", { name: "Allow browser" })
                    .disabled
            ).toBe(false)
        );
        await user.click(screen.getByRole("button", { name: "Allow browser" }));
        await waitFor(() => expect(wire.sent).toHaveLength(1));
        expect(JSON.stringify(wire.sent[0]!.body)).toContain(profile.id);
        expect(wire.sent[0]!.url).toContain("mira.browser.request");
    } finally {
        f.close();
        wire.close();
    }
});

test("profile creation and deletion stay explicit human actions with confirmation", async () => {
    const current = run(),
        wire = network(true);
    const f = fixture(
        current,
        [],
        <BrowserAccessDialog run={current} supportsImages onClose={() => {}} />
    );
    const key = ["operations", "mira", "browser-profiles"];
    const profile = {
        id: crypto.randomUUID(),
        name: "Saved sign-in",
        origins: ["https://example.test"],
        state: "active",
        busy: false,
        createdAt: new Date().toISOString(),
    };
    try {
        act(() => {
            f.query.setQueryData(key, [profile]);
        });
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "New profile" }));
        await user.type(
            screen.getByRole("textbox", { name: "Profile name" }),
            "Personal websites"
        );
        await user.type(
            screen.getByRole("textbox", { name: "Profile websites" }),
            "https://example.test\nhttps://login.test"
        );
        await user.click(screen.getByRole("button", { name: "Create profile" }));
        await waitFor(() => expect(wire.sent).toHaveLength(1));
        expect(wire.sent[0]!.url).toContain("mira.browser.createProfile");
        expect(JSON.stringify(wire.sent[0]!.body)).toContain("https://login.test");
        await screen.findByRole("alert");
        await user.click(screen.getByRole("button", { name: "Cancel new profile" }));
        await user.click(screen.getByRole("button", { name: /Browser profile/ }));
        await user.click(screen.getByRole("option", { name: "Saved sign-in" }));
        await user.click(screen.getByRole("button", { name: "Delete profile" }));
        expect(wire.sent).toHaveLength(1);
        await screen.findByRole("dialog", { name: "Delete browser profile" });
        await user.click(screen.getByRole("button", { name: "Delete profile" }));
        await waitFor(() => expect(wire.sent).toHaveLength(2));
        expect(wire.sent[1]!.url).toContain("mira.browser.deleteProfile");
        expect(JSON.stringify(wire.sent[1]!.body)).toContain(profile.id);
    } finally {
        f.close();
        wire.close();
    }
});

test("attachment upload requires explicit confirmation and freezes the website, file and observation", async () => {
    const current = run(),
        access = grant(current),
        f = fixture(current, [access], null);
    const now = Date.now();
    const file = {
        id: crypto.randomUUID(),
        name: "document.txt",
        size: 1025,
        sha256: "a".repeat(64),
    };
    const key = ["operations", "mira", "browser-uploads", access.id];
    f.query.setQueryData(key, [file]);
    const image = {
        ...preview(),
        refs: [
            {
                ref: "p1:1",
                role: "file",
                label: "Upload document",
                actions: ["upload" as const],
            },
        ],
    };
    const sent: unknown[] = [];
    const show = (view = image, disabled = false, time = now) =>
        f.rerender(
            <BrowserUploadControls
                accessId={access.id}
                preview={view}
                disabled={disabled}
                now={time}
                onCommand={(input) => sent.push(input)}
            />
        );
    const user = userEvent.setup();
    try {
        show();
        expect(screen.getByRole("button", { name: "Review upload" })).toBeDisabled();
        await user.click(
            screen.getByRole("button", { name: /^Conversation attachment/ })
        );
        await user.click(screen.getByRole("option", { name: /document.txt/ }));
        await user.click(screen.getByRole("button", { name: /^File input on the page/ }));
        await user.click(screen.getByRole("option", { name: "Upload document" }));
        await user.click(screen.getByRole("button", { name: "Review upload" }));
        expect(sent).toEqual([]);
        expect(
            screen.getByRole("dialog", { name: "Upload attachment" })
        ).toHaveTextContent(new URL(image.url).origin);
        expect(
            screen.getByRole("dialog", { name: "Upload attachment" })
        ).toHaveTextContent("document.txt");
        show({ ...image, observationId: crypto.randomUUID() });
        expect(
            screen.getByRole("button", { name: "Send file to website" })
        ).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        show();
        await user.click(screen.getByRole("button", { name: "Review upload" }));
        show(image, false, now + 11_000);
        expect(
            screen.getByRole("button", { name: "Send file to website" })
        ).toBeDisabled();
        show();
        await user.click(screen.getByRole("button", { name: "Send file to website" }));
        expect(sent).toEqual([
            {
                method: "upload",
                input: { observationId: image.observationId, ref: "p1:1" },
                origin: new URL(image.url).origin,
                file,
            },
        ]);
    } finally {
        f.close();
    }
});
