import { expect, test } from "bun:test";

import type { Incident } from "@homelab/contracts/alerts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { AlertsPanel } from "../alerts/AlertsPanel";
import { IncidentDetails } from "../alerts/IncidentDetails";
import { RulesPanel } from "../alerts/RulesPanel";
import { RuleStatus } from "../alerts/RuleStatus";
import { BackupsPanel } from "../backups/BackupsPanel";
import { SnapshotsPanel } from "../backups/SnapshotsPanel";
import { ResourceUsage } from "../infrastructure/ResourceUsage";
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

test("all monitoring rules remain searchable while inactive rules do not become incidents", async () => {
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
            configured: true,
            stale: false,
            inventory: { capturedAt: "2026-09-01T10:00:00Z", rules: [rule] },
        })
    );
    try {
        expect(screen.getByText("Normal")).toBeVisible();
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
            <ResourceUsage singleLine used={50 * 1024 ** 3} total={62.3 * 1024 ** 3} />
        </>
    );
    try {
        for (const text of ["Unknown", "Pending", "Firing", "Evaluation failed"])
            expect(screen.getByText(text)).toBeVisible();
        expect(screen.getByText("50 GiB").parentElement).toHaveClass("whitespace-nowrap");
    } finally {
        view.unmount();
    }
});

test("backup groups show sizes and counts and open read-only snapshot metadata in a modal", async () => {
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
            configured: true,
            stale: false,
            inventory: { capturedAt: group.latestAt, groups: [group] },
        });
        query.setQueryData(["operations", "snapshots", group.id], {
            pages: [
                {
                    stale: false,
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
    });
    try {
        expect(screen.getByText("32 GiB")).toBeVisible();
        await userEvent
            .setup()
            .click(
                screen.getByRole("button", { name: "Inspect snapshots for vm/demo-main" })
            );
        expect(screen.getByRole("dialog", { name: /vm\/demo-main/ })).toBeVisible();
        expect(
            screen.getByText("Logical size before deduplication and compression.")
        ).toBeVisible();
        expect(
            screen.queryByRole("button", { name: /restore|delete|load more/i })
        ).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test("incident views keep alert state independent from notification receipts", async () => {
    const cleanup = fixture(<AlertsPanel />, (query) => {
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

test("backup inventory exposes dated results and never keeps healthy status on a stale observation", async () => {
    const cleanup = fixture(<BackupsPanel />, (query) =>
        query.setQueryData(["operations", "backups"], {
            configured: true,
            stale: true,
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
        expect(screen.getByText("Stale data")).toBeVisible();
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
});

test("software views show source coverage, held security updates and read-only paginated lists", () => {
    const cleanup = fixture(<UpdatesPanel />, (query) => {
        query.setQueryData(
            ["operations", "updates"],
            [
                {
                    id: "demo",
                    label: "Demo Main",
                    stale: false,
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
        expect(screen.getByText("example")).toBeVisible();
        expect(screen.getByText("Held update")).toBeVisible();
        expect(screen.getByRole("searchbox", { name: "Search software" })).toBeVisible();
        expect(
            screen.queryByRole("button", { name: /install|upgrade|load more/i })
        ).not.toBeInTheDocument();
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
