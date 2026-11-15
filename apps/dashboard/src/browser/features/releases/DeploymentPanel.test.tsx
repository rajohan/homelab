import { expect, spyOn, test } from "bun:test";

import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { serialize } from "superjson";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { DeploymentPanel } from "./DeploymentPanel";

function fixture(
    data: { targets: Record<string, unknown>[]; history: unknown[] },
    status = "succeeded"
) {
    const requests: string[] = [];
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (input: Parameters<typeof fetch>[0]) => {
                const address = input instanceof Request ? input.url : input.toString();
                const url = new URL(address, "http://localhost");
                return Promise.resolve(
                    Response.json(
                        url.pathname
                            .split("/")
                            .at(-1)!
                            .split(",")
                            .map((path) => {
                                requests.push(path);
                                if (path === "jobs.run")
                                    return {
                                        result: {
                                            data: serialize({ id: "preparation-job" }),
                                        },
                                    };
                                if (path === "jobs.detail")
                                    return {
                                        result: {
                                            data: serialize({ run: { state: status } }),
                                        },
                                    };
                                if (path === "releases.deployment.overview")
                                    return {
                                        result: {
                                            data: serialize({
                                                ...data,
                                                targets: data.targets.map((target) => ({
                                                    ...target,
                                                    version: "1.2.3",
                                                    revision: "b".repeat(64),
                                                })),
                                            }),
                                        },
                                    };
                                throw new Error(`Unexpected request: ${path}`);
                            })
                    )
                );
            },
            { preconnect: fetch.preconnect }
        )
    );
    const client = new QueryClient({
        defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    client.setQueryData(["operations", "deployment"], {
        ...data,
        targets: data.targets.map((target) => ({
            ...target,
            policy: {
                target: target.id,
                version: 0,
                mode: "manual",
                window: { start: "03:00", minutes: 60 },
                timeZone: "UTC",
                paused: false,
                reason: null,
                until: null,
                configurationChanged: false,
            },
        })),
    });
    render(
        <QueryClientProvider client={client}>
            <IdentityClientContext value={new IdentityClient()}>
                <DeploymentPanel />
            </IdentityClientContext>
        </QueryClientProvider>
    );
    return () => {
        cleanup();
        client.clear();
        fetcher.mockRestore();
        expect(requests).not.toContain("releases.deployment.request");
    };
}

test("deployment confirmation names the frozen version and cancellation submits nothing", async () => {
    const close = fixture({
        targets: [
            {
                id: "main",
                label: "Dashboard and Mira",
                version: "1.2.2",
                revision: "a".repeat(64),
            },
        ],
        history: [],
    });
    try {
        await userEvent.click(screen.getByRole("button", { name: "Deploy release" }));
        const dialog = await screen.findByRole("dialog", { name: "Deploy 1.2.3?" });
        expect(within(dialog).getByText(/database backup/)).toBeVisible();
        await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
        close();
    }
});

test.each(["running", "unknown", "failed"])(
    "active %s deployment blocks another launch and cannot be cancelled",
    (state) => {
        const close = fixture({
            targets: [
                {
                    id: "main",
                    label: "Dashboard and Mira",
                    version: "1.2.3",
                    revision: "a".repeat(64),
                },
            ],
            history: [
                {
                    id: crypto.randomUUID(),
                    target: "main",
                    version: "1.2.3",
                    state,
                    phase: "inspection",
                    active: true,
                    message: "Work remains paused until recovery.",
                },
            ],
        });
        try {
            expect(screen.getByRole("button", { name: "Deploy release" })).toBeDisabled();
            expect(
                screen.queryByRole("button", { name: "Prepare release" })
            ).not.toBeInTheDocument();
            expect(
                screen.queryByRole("button", { name: "Cancel deployment" })
            ).not.toBeInTheDocument();
            expect(screen.getByRole("status")).toHaveTextContent(
                "Work remains paused until recovery."
            );
        } finally {
            close();
        }
    }
);

test("an expired preparation can start the single deployment flow", () => {
    const close = fixture({
        targets: [
            { id: "main", label: "Dashboard and Mira", version: null, revision: null },
        ],
        history: [],
    });
    try {
        expect(screen.getByRole("button", { name: "Deploy release" })).toBeEnabled();
        expect(
            screen.queryByRole("button", { name: "Prepare release" })
        ).not.toBeInTheDocument();
    } finally {
        close();
    }
});

test("a waiting deployment offers cancellation and empty configuration stays hidden", () => {
    let close = fixture({
        targets: [],
        history: [
            {
                id: crypto.randomUUID(),
                target: "main",
                version: "1.2.3",
                state: "waiting",
                phase: "draining",
                active: true,
                message: "Waiting for active work.",
            },
        ],
    });
    try {
        expect(screen.getByRole("button", { name: "Cancel deployment" })).toBeEnabled();
    } finally {
        close();
    }
    close = fixture({ targets: [], history: [] });
    try {
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    } finally {
        close();
    }
});

test.each(["running", "failed"])(
    "%s preflight never enables deployment and can be cancelled",
    async (status) => {
        const close = fixture(
            {
                targets: [
                    {
                        id: "main",
                        label: "Dashboard and Mira",
                        version: "1.2.2",
                        revision: "a".repeat(64),
                    },
                ],
                history: [],
            },
            status
        );
        try {
            await userEvent.click(screen.getByRole("button", { name: "Deploy release" }));
            const dialog = screen.getByRole("dialog", { name: "Deploy release" });
            expect(
                within(dialog).getByRole("button", { name: "Deploy release" })
            ).toBeDisabled();
            if (status === "failed")
                await within(dialog).findByText(/Release checks did not complete/);
            await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        } finally {
            close();
        }
    }
);
