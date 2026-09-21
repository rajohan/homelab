import { expect, test } from "bun:test";

import type { Incident } from "@homelab/contracts/alerts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    createMemoryHistory,
    createRootRoute,
    createRouter,
    RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { AlertsPanel } from "../alerts/AlertsPanel";
import { IncidentDetails } from "../alerts/IncidentDetails";
import { RulesPanel } from "../alerts/RulesPanel";
import { RuleStatus } from "../alerts/RuleStatus";
import { BackupsPanel } from "../backups/BackupsPanel";
import { SnapshotsPanel } from "../backups/SnapshotsPanel";
import { SnapshotTable } from "../backups/SnapshotTable";
import { ResourceUsage } from "../infrastructure/ResourceUsage";
import { InfrastructureHealth } from "../overview/InfrastructureHealth";
import { UpdatesPanel } from "../updates/UpdatesPanel";
import { ObservationBadge } from "./ObservationBadge";

function fixture(content: ReactNode, seed: (query: QueryClient) => void) {
    const query = new QueryClient({
        defaultOptions: {
            queries: { enabled: false, staleTime: Infinity, retry: false },
        },
    });
    seed(query);
    const view = render(
        <QueryClientProvider client={query}>
            <div
                ref={(element) => {
                    for (const viewport of element?.querySelectorAll(
                        "section[aria-label]"
                    ) ?? [])
                        Object.defineProperties(viewport, {
                            offsetHeight: { value: 520, configurable: true },
                            offsetWidth: { value: 960, configurable: true },
                        });
                }}
            >
                {content}
            </div>
        </QueryClientProvider>
    );
    return () => {
        view.unmount();
        query.clear();
    };
}

const incident: Incident = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "HostDown",
    host: "demo",
    service: "node",
    severity: "error",
    state: "active",
    startedAt: "2026-09-01T10:00:00Z",
    resolvedAt: null,
};

test.each([
    [false, false, "Not configured"],
    [false, true, "Not configured"],
    [true, false, "Awaiting data"],
    [true, true, "Live data"],
] as const)(
    "infrastructure configuration %s and retained data %s show %s",
    async (configured, retained, label) => {
        const router = createRouter({
            routeTree: createRootRoute({ component: InfrastructureHealth }),
            history: createMemoryHistory({ initialEntries: ["/"] }),
        });
        await router.load();
        const cleanup = fixture(<RouterProvider router={router} />, (query) =>
            query.setQueryData(["operations", "infrastructure", "inventory"], {
                configured,
                checkedAt: Date.now(),
                inventory: retained
                    ? {
                          capturedAt: new Date().toISOString(),
                          hosts: [],
                          applications: [],
                          services: [],
                      }
                    : null,
            })
        );
        try {
            expect(await screen.findByText(label)).toBeVisible();
            if (!configured)
                expect(screen.queryByText("Live data")).not.toBeInTheDocument();
        } finally {
            cleanup();
            router.history.destroy();
        }
    }
);

test.each([true, false])(
    "rules stay searchable with configured=%s and unavailable health stays unknown",
    async (configured) => {
        const rule = {
            id: "rule",
            name: "DemoHostMemory",
            group: "hosts",
            state: "inactive" as const,
            health: "healthy" as const,
            lastEvaluationAt: "2026-09-01T10:00:00Z",
            intervalSeconds: 30,
            durationSeconds: 120,
        };
        const cleanup = fixture(<RulesPanel />, (query) =>
            query.setQueryData(["operations", "rules"], {
                configured,
                stale: false,
                inventory: { capturedAt: "2026-09-01T10:00:00Z", rules: [rule] },
            })
        );
        try {
            expect(screen.getByText(configured ? "Normal" : "Unknown")).toBeVisible();
            if (!configured) {
                expect(screen.getByText("Not configured")).toBeVisible();
                expect(screen.queryByText("Normal")).not.toBeInTheDocument();
                await userEvent
                    .setup()
                    .click(screen.getByRole("button", { name: "Rule status" }));
                await userEvent
                    .setup()
                    .click(screen.getByRole("option", { name: "Needs attention" }));
                expect(screen.getByText("DemoHostMemory")).toBeVisible();
            }
            const user = userEvent.setup();
            await user.type(
                screen.getByRole("searchbox", { name: "Search monitoring rules" }),
                "absent"
            );
            expect(screen.getByText("No matching monitoring rules.")).toBeVisible();
        } finally {
            cleanup();
        }
        const view = render(
            <>
                <RuleStatus rule={rule} stale />
                <RuleStatus rule={{ ...rule, state: "pending" }} stale={false} />
                <RuleStatus rule={{ ...rule, state: "firing" }} stale={false} />
                <RuleStatus rule={{ ...rule, health: "error" }} stale={false} />
                <ResourceUsage
                    singleLine
                    used={50 * 1024 ** 3}
                    total={62.3 * 1024 ** 3}
                />
            </>
        );
        try {
            for (const text of ["Unknown", "Pending", "Firing", "Evaluation failed"])
                expect(screen.getByText(text)).toBeVisible();
            expect(screen.getByText("50 GiB").parentElement).toHaveClass(
                "whitespace-nowrap"
            );
        } finally {
            view.unmount();
        }
    }
);

test.each([
    [true, false, false, false],
    [true, true, false, false],
    [true, false, true, false],
    [false, false, false, false],
    [true, false, false, true],
] as const)(
    "snapshot health respects configured=%s, catalog stale=%s, page stale=%s, page error=%s",
    async (configured, catalogStale, pageStale, pageError) => {
        const group = {
            id: "a".repeat(64),
            name: "vm/demo-main",
            namespace: "",
            datastore: "demo-backups",
            snapshotCount: 3,
            latestAt: "2026-09-01T10:00:00Z",
            latestSizeBytes: 32 * 1024 ** 3,
        };
        const cleanup = fixture(<SnapshotsPanel />, (query) => {
            query.setQueryData(["operations", "backup-catalog"], {
                configured,
                stale: catalogStale,
                inventory: { capturedAt: group.latestAt, groups: [group] },
            });
            query.setQueryData(["operations", "snapshots", group.id], {
                pages: [
                    {
                        stale: pageStale,
                        nextCursor: null,
                        snapshots: (["verified", "unverified", "failed"] as const).map(
                            (verification, index) => ({
                                id: String(index),
                                groupId: group.id,
                                createdAt: group.latestAt,
                                sizeBytes: group.latestSizeBytes,
                                protected: index === 0,
                                verification,
                            })
                        ),
                    },
                ],
                pageParams: [undefined],
            });
            if (pageError)
                query
                    .getQueryCache()
                    .find({ queryKey: ["operations", "snapshots", group.id] })
                    ?.setState({
                        status: "error",
                        error: new Error("Synthetic catalog failure"),
                    });
        });
        try {
            expect(screen.getByText("32 GiB")).toBeVisible();
            await userEvent.setup().click(
                screen.getByRole("button", {
                    name: "Inspect snapshots for vm/demo-main",
                })
            );
            expect(screen.getByRole("dialog", { name: /vm\/demo-main/ })).toBeVisible();
            if (!configured || catalogStale || pageStale || pageError) {
                expect(screen.getByText("Snapshot status unavailable")).toBeVisible();
            } else {
                expect(
                    screen.queryByText("Snapshot status unavailable")
                ).not.toBeInTheDocument();
            }
            expect(
                screen.getByText("Logical size before deduplication and compression.")
            ).toBeVisible();
            expect(
                screen.queryByRole("button", { name: /restore|delete|load more/i })
            ).not.toBeInTheDocument();
        } finally {
            cleanup();
        }
    }
);

test.each([true, false])(
    "snapshot table marks both protection and verification unavailable=%s",
    (unavailable) => {
        const cleanup = fixture(
            <SnapshotTable
                unavailable={unavailable}
                snapshots={[true, false].map((protectedValue, index) => ({
                    id: String(index),
                    groupId: "demo",
                    createdAt: "2026-09-01T10:00:00Z",
                    sizeBytes: 1024,
                    verification: "verified",
                    protected: protectedValue,
                }))}
            />,
            () => {}
        );
        try {
            if (unavailable) {
                expect(screen.queryByText("Yes")).not.toBeInTheDocument();
                expect(screen.queryByText("No")).not.toBeInTheDocument();
                expect(screen.getAllByText("Unknown")).toHaveLength(4);
            } else {
                expect(screen.getByText("Yes")).toBeVisible();
                expect(screen.getByText("No")).toBeVisible();
                expect(screen.getAllByText("Verified")).toHaveLength(2);
            }
        } finally {
            cleanup();
        }
    }
);

test("incident views keep alert state independent from notification receipts", async () => {
    let client: QueryClient | undefined;
    const cleanup = fixture(<AlertsPanel />, (query) => {
        client = query;
        const page = {
            incidents: [incident],
            nextCursor: null,
            counts: [{ state: "active", count: 1 }],
            configured: true,
            stale: false,
            capturedAt: "2026-09-01T11:00:00Z",
        };
        query.setQueryData(["operations", "alerts", "current"], {
            pages: [page],
            pageParams: [undefined],
        });
        query.setQueryData(["operations", "alerts", "resolved"], {
            pages: [{ ...page, incidents: [] }],
            pageParams: [undefined],
        });
    });
    try {
        expect(screen.getByText("Live data")).toBeVisible();
        expect(screen.getByRole("button", { name: "Inspect HostDown" })).toBeVisible();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Inspect HostDown" }));
        expect(screen.getByRole("dialog", { name: /HostDown/ })).toBeVisible();
        expect(
            screen.queryByRole("button", {
                name: /resolve|silence|dismiss notification/i,
            })
        ).not.toBeInTheDocument();
        client?.setQueryData(["operations", "alerts", "current"], {
            pages: [
                {
                    configured: true,
                    stale: false,
                    capturedAt: "2026-09-01T11:01:00Z",
                    counts: [],
                    incidents: [],
                    nextCursor: null,
                },
            ],
            pageParams: [undefined],
        });
        await waitFor(() =>
            expect(
                within(screen.getByRole("dialog", { name: /HostDown/ })).getAllByText(
                    "Unknown"
                )
            ).toHaveLength(2)
        );
        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Incident history" }));
        await user.click(screen.getByRole("option", { name: "Resolved incidents" }));
        expect(
            screen.getByText("No resolved incidents in retained history.")
        ).toBeVisible();
        expect(
            screen.queryByRole("button", { name: /load more/i })
        ).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test.each([
    [true, false, false, false],
    [false, false, false, false],
    [true, true, false, false],
    [true, false, true, false],
    [true, false, false, true],
] as const)(
    "incident current state respects configured=%s, stale=%s, page stale=%s and failed=%s",
    async (configured, stale, pageStale, failed) => {
        const unavailable = !configured || stale || pageStale || failed;
        const cleanup = fixture(<AlertsPanel />, (query) => {
            const page = {
                configured,
                stale,
                capturedAt: "2026-09-01T11:00:00Z",
                nextCursor: null,
                counts: [
                    { state: "active", count: 3 },
                    { state: "suppressed", count: 1 },
                    { state: "resolved", count: 2 },
                ],
            };
            query.setQueryData(["operations", "alerts", "current"], {
                pages: [
                    { ...page, incidents: [incident] },
                    {
                        ...page,
                        stale: pageStale,
                        incidents: [
                            {
                                ...incident,
                                id: "warning",
                                name: "WarningHost",
                                severity: "warning",
                            },
                            {
                                ...incident,
                                id: "info",
                                name: "InfoHost",
                                severity: "info",
                            },
                            {
                                ...incident,
                                id: "suppressed",
                                name: "SuppressedHost",
                                state: "suppressed",
                            },
                        ],
                    },
                ],
                pageParams: [undefined, "next"],
            });
            query.setQueryData(["operations", "alerts", "resolved"], {
                pages: [
                    {
                        ...page,
                        incidents: [
                            {
                                ...incident,
                                state: "resolved",
                                resolvedAt: "2026-09-01T11:00:00Z",
                            },
                        ],
                    },
                ],
                pageParams: [undefined],
            });
            if (failed)
                query
                    .getQueryCache()
                    .find({ queryKey: ["operations", "alerts", "current"] })
                    ?.setState({
                        status: "error",
                        error: new Error("Synthetic monitoring failure"),
                    });
        });
        try {
            expect(
                screen.getByText("Active", { selector: "dt" }).nextElementSibling
            ).toHaveTextContent(unavailable ? "—" : "3");
            expect(
                screen.getByText("Suppressed", { selector: "dt" }).nextElementSibling
            ).toHaveTextContent(unavailable ? "—" : "1");
            expect(
                screen.getByText("Resolved", { selector: "dt" }).nextElementSibling
            ).toHaveTextContent("2");
            for (const label of ["Critical", "Warning", "Active", "Suppressed"]) {
                const badge = screen.queryByText(label, { selector: "span" });
                if (unavailable) expect(badge).not.toBeInTheDocument();
                else expect(badge).toBeVisible();
            }
            if (unavailable) expect(screen.getAllByText("Unknown")).toHaveLength(4);
            const user = userEvent.setup();
            await user.click(screen.getByRole("button", { name: "Inspect HostDown" }));
            const dialog = within(screen.getByRole("dialog", { name: /HostDown/ }));
            if (unavailable) {
                expect(dialog.getAllByText("Unknown")).toHaveLength(2);
                expect(dialog.queryByText("Not resolved")).not.toBeInTheDocument();
            } else expect(dialog.getByText("Not resolved")).toBeVisible();
            await user.keyboard("{Escape}");
            await user.click(screen.getByRole("button", { name: "Incident history" }));
            await user.click(screen.getByRole("option", { name: "Resolved incidents" }));
            expect(
                screen.getByText("Resolved", { selector: "span.text-emerald-300" })
            ).toBeVisible();
            await user.click(screen.getByRole("button", { name: "Inspect HostDown" }));
            expect(
                within(screen.getByRole("dialog", { name: /HostDown/ })).getByText(
                    "Resolved",
                    { selector: "span" }
                )
            ).toBeVisible();
        } finally {
            cleanup();
        }
    }
);

test.each([
    [true, true, "Stale data"],
    [false, false, "Not configured"],
] as const)(
    "backup inventory configuration %s and stale %s never claim retained health",
    async (configured, stale, label) => {
        const cleanup = fixture(<BackupsPanel />, (query) =>
            query.setQueryData(["operations", "backups"], {
                configured,
                stale,
                inventory: {
                    capturedAt: "2026-09-01T10:00:00Z",
                    backups: [
                        {
                            id: "demo",
                            host: "demo",
                            task: "postgres-logical",
                            state: "healthy",
                            lastSuccessAt: "2026-09-01T10:00:00Z",
                            lastFailureAt: null,
                            maximumAgeSeconds: 86_400,
                        },
                    ],
                },
            })
        );
        try {
            expect(screen.getByText(label)).toBeVisible();
            expect(
                screen.getByText("Healthy", { selector: "dt" }).nextElementSibling
            ).toHaveTextContent("—");
            expect(
                screen.getByText("Needs attention", { selector: "dt" }).nextElementSibling
            ).toHaveTextContent("—");
            expect(
                screen.getByText("Unknown", { selector: "dt" }).nextElementSibling
            ).toHaveTextContent("1");
            expect(screen.getByText("Unknown", { selector: "span" })).toHaveClass(
                "text-amber-300"
            );
            expect(
                screen.queryByText("Healthy", { selector: "span" })
            ).not.toBeInTheDocument();
            expect(screen.getByText("postgres-logical")).toBeVisible();
            const user = userEvent.setup();
            await user.type(
                screen.getByRole("searchbox", { name: "Search backups" }),
                "missing"
            );
            expect(screen.getByText("No matching backup tasks.")).toBeVisible();
            expect(
                screen.queryByRole("button", { name: /restore|delete/i })
            ).not.toBeInTheDocument();
        } finally {
            cleanup();
        }
    }
);

test("software views show source coverage, held security updates and read-only paginated lists", () => {
    const cleanup = fixture(<UpdatesPanel />, (query) => {
        query.setQueryData(
            ["operations", "updates"],
            [
                {
                    id: "demo",
                    label: "Demo Main",
                    stale: false,
                    restart: {
                        required: true,
                        observedAt: "2026-09-01T10:00:00Z",
                        stale: false,
                    },
                    report: {
                        capturedAt: "2026-09-01T10:00:00Z",
                        repositoryMetadataAt: "2026-09-01T09:00:00Z",
                        complete: true,
                        coveredKinds: ["os"],
                        total: 200,
                        available: 1,
                        security: 1,
                    },
                },
            ]
        );
        query.setQueryData(["operations", "updates", "demo", "", "attention"], {
            pages: [
                {
                    items: [
                        {
                            id: "apt:example",
                            name: "example",
                            kind: "os",
                            installed: "1.0-1",
                            available: "1.1-1",
                            status: "available",
                            security: true,
                            held: true,
                        },
                    ],
                    stale: false,
                    nextCursor: null,
                },
            ],
            pageParams: [undefined],
        });
    });
    try {
        const sourceRow = within(
            screen.getByRole("table", { name: "Update sources" })
        ).getByRole("row", { name: /Demo Main/ });
        const badges = within(sourceRow).getAllByText("Restart required");
        expect(badges).toHaveLength(2);
        expect(badges[0]?.closest("td")).toHaveTextContent("Live data");
        expect(badges[0]?.parentElement?.parentElement).toHaveClass(
            "@min-[48rem]:hidden"
        );
        expect(badges[1]?.closest("td")).toHaveClass("@max-[48rem]:hidden");
        expect(screen.getByText("example")).toBeVisible();
        expect(screen.getByText("Held update")).toBeVisible();
        expect(screen.getByRole("searchbox", { name: "Search software" })).toBeVisible();
        expect(
            screen.queryByRole("button", {
                name: /^(?:install|upgrade|load more)(?: |$)/i,
            })
        ).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test("host selector reuses one software and policy view for toolchains and falls back when coverage changes", async () => {
    let updateQuery: QueryClient | undefined;
    const sources = [
        {
            id: "main",
            label: "Main",
            stale: false,
            report: {
                coveredKinds: ["os", "runtime"],
                available: 1,
                security: 0,
                capturedAt: "2026-09-01T10:00:00Z",
            },
        },
        {
            id: "db",
            label: "DB",
            stale: false,
            report: {
                coveredKinds: ["os"],
                available: 1,
                security: 0,
                capturedAt: "2026-09-01T10:00:00Z",
            },
        },
    ];
    const cleanup = fixture(<UpdatesPanel />, (query) => {
        updateQuery = query;
        query.setQueryData(["operations", "updates"], sources);
        query.setQueryData(["operations", "updates", "policies"], []);
        for (const [source, category, name] of [
            ["main", "software", "Main package"],
            ["main", "toolchains", "Bun"],
            ["db", "software", "DB package"],
        ] as const) {
            query.setQueryData(
                [
                    "operations",
                    "updates",
                    source,
                    "",
                    "attention",
                    ...(category === "toolchains" ? [category] : []),
                ],
                {
                    pages: [
                        {
                            items: [
                                {
                                    id: name,
                                    name,
                                    kind: category === "toolchains" ? "runtime" : "os",
                                    installed: "1.0.0",
                                    available: "1.1.0",
                                    status: "available",
                                    security: false,
                                    held: false,
                                },
                            ],
                            stale: false,
                            nextCursor: null,
                        },
                    ],
                    pageParams: [undefined],
                }
            );
        }
    });
    try {
        const user = userEvent.setup();
        expect(screen.getByText("Main package")).toBeVisible();
        expect(screen.queryByText("Bun")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Software source" }));
        expect(
            screen.queryByRole("option", { name: "DB · Toolchains" })
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole("option", { name: "Main · Toolchains" }));
        expect(screen.getByRole("table", { name: "Toolchain updates" })).toBeVisible();
        expect(
            screen.queryByRole("table", { name: "Software updates" })
        ).not.toBeInTheDocument();
        expect(screen.queryByText("Main package")).not.toBeInTheDocument();
        expect(
            screen.getAllByRole("searchbox", { name: "Search software" })
        ).toHaveLength(1);
        expect(
            screen.getAllByRole("heading", { name: "Automatic updates" })
        ).toHaveLength(1);
        expect(
            screen.queryByRole("heading", { name: "Toolchains" })
        ).not.toBeInTheDocument();
        await user.type(
            screen.getByRole("searchbox", { name: "Search software" }),
            "filtered"
        );
        await user.click(screen.getByRole("button", { name: "Software source" }));
        await user.click(screen.getByRole("option", { name: "DB" }));
        expect(screen.getByRole("searchbox", { name: "Search software" })).toHaveValue(
            ""
        );
        expect(screen.getByRole("table", { name: "Software updates" })).toBeVisible();
        expect(
            screen.queryByRole("table", { name: "Toolchain updates" })
        ).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Software source" }));
        await user.click(screen.getByRole("option", { name: "Main · Toolchains" }));
        updateQuery?.setQueryData(
            ["operations", "updates"],
            sources.map((source) => ({
                ...source,
                report: { ...source.report, coveredKinds: ["os"] },
            }))
        );
        await waitFor(() =>
            expect(
                screen.getByRole("button", { name: "Software source" })
            ).not.toHaveTextContent("Toolchains")
        );
        expect(screen.getByRole("table", { name: "Software updates" })).toBeVisible();
        expect(screen.queryByText("Bun")).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test.each([
    "pending",
    "failed",
    "empty",
    "cached-empty-failed",
    "cached-failed",
] as const)("update source configuration is not inferred from %s requests", (state) => {
    const cleanup = fixture(<UpdatesPanel />, (query) => {
        const key = ["operations", "updates"];
        if (state === "empty" || state === "cached-empty-failed")
            query.setQueryData(key, []);
        if (state === "cached-failed")
            query.setQueryData(key, [
                {
                    id: "demo",
                    label: "Demo Main",
                    stale: false,
                    report: {
                        capturedAt: "2026-09-01T10:00:00Z",
                        coveredKinds: ["os"],
                        available: 2,
                        security: 1,
                    },
                },
            ]);
        if (state.includes("failed"))
            query
                .getQueryCache()
                .build(query, { queryKey: key })
                .setState({
                    status: "error",
                    error: new Error("Synthetic inventory failure"),
                });
    });
    try {
        if (state === "empty") {
            expect(screen.getByText("Not configured")).toBeVisible();
            expect(screen.getByText("No update sources are configured.")).toBeVisible();
        } else {
            expect(screen.queryByText("Not configured")).not.toBeInTheDocument();
            expect(
                screen.queryByText("No update sources are configured.")
            ).not.toBeInTheDocument();
            if (state === "cached-failed") {
                expect(screen.getAllByText("Stale data")).toHaveLength(2);
                expect(screen.queryByText("Live data")).not.toBeInTheDocument();
                expect(
                    screen.getByText("Available", { selector: "dt" }).nextElementSibling
                ).toHaveTextContent("—");
            } else expect(screen.getByText("Awaiting data")).toBeVisible();
        }
    } finally {
        cleanup();
    }
});

test("freshness and incident detail fallbacks stay explicit without action controls", () => {
    const view = render(
        <>
            <ObservationBadge configured={false} available={false} stale />
            <ObservationBadge configured available={false} stale />
            <IncidentDetails
                unavailable
                incident={{
                    ...incident,
                    host: null,
                    service: null,
                    state: "resolved",
                    resolvedAt: "2026-09-01T11:00:00Z",
                }}
                onClose={() => {}}
            />
        </>
    );
    try {
        expect(screen.getByText("Not configured")).toBeInTheDocument();
        expect(screen.getByText("Awaiting data")).toBeInTheDocument();
        expect(screen.getAllByText("Not reported")).toHaveLength(2);
    } finally {
        view.unmount();
    }
});
