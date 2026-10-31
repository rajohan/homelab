import { expect, spyOn, test } from "bun:test";

import type { MiraSwitch } from "@homelab/contracts/mira";
import { formatDateTime } from "@homelab/ui";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { serialize } from "superjson";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { MiraBrowserControl } from "./MiraBrowserControl";

function fixture(enabled: boolean, until: string | null = null) {
    const sent: { url: string; body: unknown }[] = [];
    const network = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
                if (
                    init?.method !== "POST" ||
                    typeof init.body !== "string" ||
                    typeof url !== "string"
                )
                    throw new Error("Expected only the selected control mutation.");
                sent.push({ url, body: JSON.parse(init.body) as unknown });
                return Promise.resolve(
                    Response.json([{ result: { data: serialize(undefined) } }])
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const control: MiraSwitch = {
        key: "computer:browser",
        enabled,
        version: 7,
        reason: enabled ? null : "Awaiting browser qualification",
        until,
    };
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
    query.setQueryData(
        ["operations", "mira", "controls"],
        [{ ...control, key: "autonomy", enabled: true }, control]
    );
    const identity = new IdentityClient();
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>
                <MiraBrowserControl />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    return {
        sent,
        close() {
            view.unmount();
            identity.cancelActions();
            query.clear();
            network.mockRestore();
        },
    };
}

test("Browser enable changes only the existing account control without granting a session", async () => {
    const f = fixture(false);
    try {
        expect(screen.getByText("Awaiting browser qualification")).toBeInTheDocument();
        expect(f.sent).toHaveLength(0);
        await userEvent
            .setup()
            .click(screen.getByRole("button", { name: "Enable Browser" }));
        await waitFor(() => expect(f.sent).toHaveLength(1));
        expect(f.sent[0]!.url).toContain("mira.controls.setEnabled");
        expect(f.sent[0]!.body).toEqual({
            "0": {
                json: {
                    key: "computer:browser",
                    version: 7,
                    enabled: true,
                    reason: null,
                    until: null,
                },
            },
        });
    } finally {
        f.close();
    }
});

test("Browser pause uses the shared reason dialog independently of automatic work", async () => {
    const f = fixture(true);
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Pause Browser" }));
        expect(screen.getByRole("dialog", { name: "Pause Browser" })).toBeInTheDocument();
        expect(f.sent).toHaveLength(0);
        await user.type(
            screen.getByRole("textbox", { name: "Reason" }),
            "Temporary browser pause"
        );
        await user.click(screen.getByRole("button", { name: "Pause" }));
        await waitFor(() => expect(f.sent).toHaveLength(1));
        expect(f.sent[0]!.body).toEqual({
            "0": {
                json: {
                    key: "computer:browser",
                    version: 7,
                    enabled: false,
                    reason: "Temporary browser pause",
                    until: null,
                },
            },
        });
    } finally {
        f.close();
    }
});

test("Browser status keeps the automatic resume time visible after the pause dialog closes", () => {
    const until = "2026-11-02T09:30:00.000Z";
    const f = fixture(false, until);
    try {
        expect(screen.getByText(/Awaiting browser qualification/)).toHaveTextContent(
            `Awaiting browser qualification · Resumes ${formatDateTime(until)}`
        );
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(f.sent).toHaveLength(0);
    } finally {
        f.close();
    }
});
