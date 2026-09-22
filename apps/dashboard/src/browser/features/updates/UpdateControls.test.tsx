import { expect, test } from "bun:test";

import type {
    UpdateItem,
    UpdatePolicy,
    UpdateBatchPlan,
} from "@homelab/contracts/updates";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { AutomaticUpdates } from "./AutomaticUpdates";
import { UpdateAction } from "./UpdateAction";
import { UpdateBatchAction } from "./UpdateBatchAction";
import { UpdateBatchDialog } from "./UpdateBatchDialog";
import { UpdatePolicyControl } from "./UpdatePolicyControl";
import { UpdatesPanel } from "./UpdatesPanel";

const item: UpdateItem = {
    id: "demo",
    name: "Demo",
    kind: "container",
    installed: "old",
    available: "new",
    status: "available",
    held: false,
    security: false,
    image: "example/web:1.0.0",
    availableImage: "example/web:1.1.0@sha256:" + "a".repeat(64),
};
const policy: UpdatePolicy = {
    target: "demo",
    label: "Demo application",
    source: "demo",
    enabled: false,
    version: 0,
    configurationChanged: false,
};

function fixture(
    content: ReactNode,
    policies: readonly UpdatePolicy[] = [],
    configure?: (query: QueryClient) => void
) {
    const identity = new IdentityClient();
    const query = new QueryClient({
        defaultOptions: {
            queries: { enabled: false, retry: false, staleTime: Infinity },
        },
    });
    query.setQueryData(["operations", "updates", "policies"], policies);
    configure?.(query);
    const view = render(
        <QueryClientProvider client={query}>
            <IdentityClientContext value={identity}>{content}</IdentityClientContext>
        </QueryClientProvider>
    );
    return () => {
        view.unmount();
        identity.cancelActions();
        query.clear();
    };
}

const batchPlan: UpdateBatchPlan = {
    revision: "a".repeat(64),
    eligible: 1,
    excluded: 0,
    hosts: 1,
    entries: [
        {
            source: "demo",
            sourceLabel: "Demo",
            item,
            reason: null,
            control: {
                target: "demo",
                revision: "b".repeat(64),
                change: "minor",
                allowed: true,
                reason: null,
            },
        },
    ],
};

test.each([true, false])(
    "bulk confirmation is scoped and cancellable (one host: %s)",
    async (scoped) => {
        const height = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetHeight"
        )!;
        const width = Object.getOwnPropertyDescriptor(
            HTMLElement.prototype,
            "offsetWidth"
        )!;
        Object.defineProperties(HTMLElement.prototype, {
            offsetHeight: { configurable: true, value: 400 },
            offsetWidth: { configurable: true, value: 960 },
        });
        const source = scoped ? "demo" : undefined;
        const cleanup = fixture(
            <UpdateBatchAction
                {...(source ? { source, label: "Demo" } : {})}
                disabled={false}
            />,
            [],
            (query) => {
                query.setQueryData(
                    ["operations", "updates", "batch", source ?? null],
                    batchPlan
                );
            }
        );
        try {
            const user = userEvent.setup();
            const button = screen.getByRole("button", {
                name: scoped ? "Update all on Demo" : "Update all hosts",
            });
            expect(button).toHaveClass("w-full");
            expect(button.querySelector("svg")).toHaveClass("size-4", "shrink-0");
            await user.click(button);
            const dialog = screen.getByRole("dialog", {
                name: scoped ? "Update all on Demo?" : "Update all hosts?",
            });
            expect(dialog).toHaveAccessibleDescription(/Updates run in sequence/);
            expect(screen.getByText("1 update included")).toBeVisible();
            expect(screen.getByRole("button", { name: "Update all" })).toBeEnabled();
            const checkbox = screen.getByRole("checkbox", {
                name: "Include Demo on Demo",
            });
            expect(checkbox).toBeChecked();
            await user.click(checkbox);
            expect(screen.getByText("0 updates included")).toBeVisible();
            expect(screen.getByRole("button", { name: "Update all" })).toBeDisabled();
            await user.click(checkbox);
            expect(screen.getByRole("button", { name: "Update all" })).toBeEnabled();
            await user.click(screen.getByRole("button", { name: "Cancel" }));
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        } finally {
            cleanup();
            Object.defineProperties(HTMLElement.prototype, {
                offsetHeight: height,
                offsetWidth: width,
            });
        }
    }
);

test.each(["pending", "empty", "excluded", "failed"] as const)(
    "bulk confirmation cannot submit a %s plan",
    (state) => {
        const cleanup = fixture(<UpdateBatchDialog onClose={() => {}} />, [], (query) => {
            const key = ["operations", "updates", "batch", null];
            if (state === "empty")
                query.setQueryData(key, {
                    ...batchPlan,
                    eligible: 0,
                    hosts: 0,
                    entries: [],
                });
            if (state === "excluded")
                query.setQueryData(key, {
                    ...batchPlan,
                    eligible: 0,
                    hosts: 0,
                    excluded: 1,
                    entries: [
                        {
                            ...batchPlan.entries[0]!,
                            reason: "Major upgrades require separate confirmation.",
                        },
                    ],
                });
            if (state === "failed") {
                query.setQueryData(key, batchPlan);
                query
                    .getQueryCache()
                    .find({ queryKey: key })
                    ?.setState({ status: "error", error: new Error("Plan unavailable") });
            }
        });
        try {
            expect(screen.getByRole("button", { name: "Update all" })).toBeDisabled();
            if (state === "failed") expect(screen.getByRole("alert")).toBeVisible();
            if (state === "excluded")
                expect(screen.getByText("1 not included")).toBeVisible();
            expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
        } finally {
            cleanup();
        }
    }
);

test("source inventory includes per-host counts, one global action and full-width host actions", () => {
    const height = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "offsetHeight"
    )!;
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
    Object.defineProperties(HTMLElement.prototype, {
        offsetHeight: { configurable: true, value: 400 },
        offsetWidth: { configurable: true, value: 960 },
    });
    const cleanup = fixture(<UpdatesPanel />, [], (query) =>
        query.setQueryData(
            ["operations", "updates"],
            [
                {
                    id: "demo",
                    label: "Demo",
                    stale: false,
                    report: {
                        capturedAt: new Date().toISOString(),
                        available: 7,
                        security: 1,
                        coveredKinds: ["os"],
                    },
                },
                {
                    id: "stale",
                    label: "Stale host",
                    stale: true,
                    report: {
                        capturedAt: new Date().toISOString(),
                        available: 19,
                        security: 0,
                        coveredKinds: ["os"],
                    },
                },
            ]
        )
    );
    try {
        expect(screen.getByRole("columnheader", { name: "Updates" })).toBeInTheDocument();
        expect(
            screen.getByRole("columnheader", { name: "Inventory observed" })
        ).toBeInTheDocument();
        expect(
            screen.getByRole("columnheader", { name: "Package lists refreshed" })
        ).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Update all hosts" })).toBeEnabled();
        expect(screen.getByRole("button", { name: "Update all on Demo" })).toHaveClass(
            "w-full"
        );
        expect(
            screen.getByRole("button", { name: "Update all on Stale host" })
        ).toBeDisabled();
        expect(screen.queryByText("19")).not.toBeInTheDocument();
    } finally {
        cleanup();
        Object.defineProperties(HTMLElement.prototype, {
            offsetHeight: height,
            offsetWidth: width,
        });
    }
});

test("manual update confirmation describes persisted Compose pins and remains cancellable", async () => {
    const cleanup = fixture(
        <UpdateAction
            item={item}
            control={{
                target: "demo",
                revision: "a".repeat(64),
                change: "minor",
                allowed: true,
                reason: null,
            }}
            disabled={false}
        />
    );
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Update" }));
        expect(screen.getByRole("dialog", { name: "Update Demo?" })).toBeVisible();
        expect(screen.getByText(/Compose image pin will be updated/)).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test.each([true, false])(
    "unsafe or stale update controls stay disabled (stale=%s)",
    (stale) => {
        const cleanup = fixture(
            <UpdateAction
                item={item}
                control={{
                    target: "demo",
                    revision: "a".repeat(64),
                    change: "unknown",
                    allowed: stale,
                    reason: "Refresh the software inventory.",
                }}
                disabled={stale}
            />
        );
        try {
            expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
        } finally {
            cleanup();
        }
    }
);

test("automatic update switches require confirmation without preemptively enabling policy", async () => {
    const cleanup = fixture(<UpdatePolicyControl policy={policy} disabled={false} />);
    try {
        const user = userEvent.setup();
        const toggle = screen.getByRole("switch", { name: policy.label });
        expect(toggle).not.toBeChecked();
        await user.click(toggle);
        expect(
            screen.getByRole("dialog", { name: "Enable automatic updates?" })
        ).toBeVisible();
        expect(toggle).not.toBeChecked();
        expect(
            screen.getByText(/held packages and major upgrades require manual action/)
        ).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(toggle).not.toBeChecked();
    } finally {
        cleanup();
    }
});

test("source policy lists show only the selected source and explain absent installation access", () => {
    const cleanup = fixture(<AutomaticUpdates source="other" />, [policy]);
    try {
        expect(
            screen.getByText("Update installation is not configured for this source.")
        ).toBeVisible();
        expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    } finally {
        cleanup();
    }
});

test("changed automatic updater recipes require renewed consent", () => {
    const cleanup = fixture(
        <UpdatePolicyControl
            policy={{ ...policy, configurationChanged: true }}
            disabled
        />
    );
    try {
        expect(screen.getByText(/configuration changed/)).toBeVisible();
        expect(screen.getByRole("switch")).toBeDisabled();
    } finally {
        cleanup();
    }
});

test("long automatic update lists use a bounded virtual scroll region", () => {
    const height = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        "offsetHeight"
    )!;
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!;
    Object.defineProperties(HTMLElement.prototype, {
        offsetHeight: { configurable: true, value: 400 },
        offsetWidth: { configurable: true, value: 960 },
    });
    const cleanup = fixture(
        <AutomaticUpdates source="demo" />,
        Array.from({ length: 100 }, (_, index) => ({
            ...policy,
            target: `target-${index}`,
            label: `Application ${index}`,
        }))
    );
    try {
        const region = screen.getByRole("region", { name: "Automatic update targets" });
        expect(region).toHaveClass("max-h-[min(26rem,50dvh)]", "overflow-auto");
        expect(region.querySelector("ul")).toHaveClass("pe-2");
        expect(screen.getAllByRole("switch").length).toBeGreaterThan(0);
        expect(screen.getAllByRole("switch").length).toBeLessThan(100);
    } finally {
        cleanup();
        Object.defineProperties(HTMLElement.prototype, {
            offsetHeight: height,
            offsetWidth: width,
        });
    }
});
