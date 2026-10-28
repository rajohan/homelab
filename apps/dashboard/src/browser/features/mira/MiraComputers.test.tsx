import { expect, spyOn, test } from "bun:test";

import type { MiraComputerSummary } from "@homelab/contracts/miraComputers";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { serialize } from "superjson";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { MiraComputers } from "./MiraComputers";

function fixture(rows: MiraComputerSummary[], release?: unknown) {
    const query = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    query.setQueryData(["operations", "mira", "computers"], rows);
    query.setQueryData(
        ["operations", "mira", "computer-download"],
        release ?? { download: null, expiresAt: null }
    );
    const identity = new IdentityClient();
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <MiraComputers />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    return Object.assign(
        () => {
            view.unmount();
            identity.cancelActions();
            query.clear();
        },
        { query }
    );
}
function computer(
    state: MiraComputerSummary["state"],
    connected = false
): MiraComputerSummary {
    return {
        id: crypto.randomUUID(),
        label: state === "paired" ? "Desktop" : state,
        state,
        connected,
        version: 2,
        platform: "win32",
        companionVersion: "0.10.0",
        pairedAt: null,
        lastSeenAt: null,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
}

test("computer inventory distinguishes presence, pending, revoked and expired without implying input access", async () => {
    const cleanup = fixture([
        computer("paired", true),
        { ...computer("paired"), label: "Laptop" },
        computer("pending"),
        computer("revoked"),
        { ...computer("pending"), expiresAt: "2000-01-01T00:00:00.000Z" },
    ]);
    try {
        for (const text of [
            "Connected",
            "Offline",
            "Waiting for pairing",
            "Revoked",
            "Expired",
        ])
            expect(screen.getByText(text)).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(2);
        await userEvent
            .setup()
            .click(screen.getAllByRole("button", { name: "Revoke" })[0]!);
        const dialog = screen.getByRole("dialog");
        expect(within(dialog).getByText(/Desktop will no longer/)).toBeInTheDocument();
        await userEvent
            .setup()
            .click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test("pairing sends only the label and clears the one-time code on dialog close", async () => {
    const requests: unknown[] = [];
    const token = "synthetic-one-use-ticket";
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (typeof init?.body !== "string") throw new Error("Expected test JSON");
                requests.push(JSON.parse(init.body));
                return Promise.resolve(
                    Response.json([
                        {
                            result: {
                                data: serialize({
                                    id: crypto.randomUUID(),
                                    token,
                                    version: 1,
                                    expiresAt: new Date(
                                        Date.now() + 600_000
                                    ).toISOString(),
                                }),
                            },
                        },
                    ])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture([]);
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Pair computer" }));
        await user.type(
            screen.getByRole("textbox", { name: "Computer name" }),
            "My Windows PC"
        );
        await user.click(screen.getByRole("button", { name: "Create pairing code" }));
        expect(await screen.findByText(token)).toBeInTheDocument();
        expect(
            JSON.stringify(
                cleanup.query
                    .getMutationCache()
                    .getAll()
                    .map((mutation) => mutation.state.data)
            )
        ).not.toContain(token);
        expect(requests).toEqual([{ "0": { json: { label: "My Windows PC" } } }]);
        expect(screen.getByText(/separate permission/)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Done" }));
        expect(screen.queryByText(token)).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Pair computer" }));
        expect(screen.getByRole("textbox", { name: "Computer name" })).toHaveValue("");
        expect(screen.queryByText(token)).not.toBeInTheDocument();
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("revoke sends the displayed version and keeps a failed confirmation open", async () => {
    const row = computer("paired");
    const sent: unknown[] = [];
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (typeof init?.body !== "string") throw new Error("Expected test JSON");
                sent.push(JSON.parse(init.body));
                return Promise.reject(new Error("Synthetic connection interrupted"));
            },
            { preconnect: fetch.preconnect }
        )
    );
    const cleanup = fixture([row]);
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Revoke" }));
        await user.click(screen.getByRole("button", { name: "Revoke computer" }));
        await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
        expect(sent).toEqual([{ "0": { json: { id: row.id, version: row.version } } }]);
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Revoke computer" })).toBeEnabled();
    } finally {
        cleanup();
        request.mockRestore();
    }
});

test("Windows download uses the shared button and only older stable Windows clients show an update", () => {
    const release = {
        download: {
            version: "0.10.1",
            url: "https://github.com/demo/homelab/releases/download/v0.10.1/mira-computer-0.10.1-windows-x64-setup.exe",
        },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const cleanup = fixture(
        [
            { ...computer("paired"), label: "Older", companionVersion: "0.9.9" },
            { ...computer("paired"), label: "Current", companionVersion: "0.10.1" },
            { ...computer("paired"), label: "Newer", companionVersion: "0.11.0" },
            { ...computer("paired"), label: "Preview", companionVersion: "0.10.0-rc.1" },
            { ...computer("paired"), label: "Unknown", companionVersion: null },
            { ...computer("paired"), label: "Linux", platform: "linux" },
            computer("revoked"),
            computer("pending"),
        ],
        release
    );
    try {
        const link = screen.getByRole("link", { name: "Download Windows" });
        expect(link).toHaveAttribute("href", release.download.url);
        expect(link.className).toContain("inline-flex");
        expect(screen.getAllByText("Update available")).toHaveLength(1);
        expect(screen.getByText("Older").closest("section")).toContainElement(
            screen.getByText("Update available")
        );
    } finally {
        cleanup();
    }
});

test("expired Windows release evidence hides the download action", () => {
    const cleanup = fixture([], {
        download: { version: "0.10.1", url: "https://github.com/demo/homelab" },
        expiresAt: "2000-01-01T00:00:00.000Z",
    });
    try {
        expect(
            screen.queryByRole("link", { name: "Download Windows" })
        ).not.toBeInTheDocument();
        expect(screen.getByText(/Windows download is unavailable/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Pair computer" })).toBeEnabled();
    } finally {
        cleanup();
    }
});
