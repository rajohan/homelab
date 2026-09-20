import { expect, test } from "bun:test";

import type { UpdateItem, UpdatePolicy } from "@homelab/contracts/updates";
import { IdentityClient } from "@homelab/ui/identity/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { IdentityClientContext } from "../../identity/IdentityClientContext";
import { AutomaticUpdates } from "./AutomaticUpdates";
import { UpdateAction } from "./UpdateAction";
import { UpdatePolicyControl } from "./UpdatePolicyControl";

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

function fixture(content: ReactNode, policies: readonly UpdatePolicy[] = []) {
    const identity = new IdentityClient();
    const query = new QueryClient({
        defaultOptions: {
            queries: { enabled: false, retry: false, staleTime: Infinity },
        },
    });
    query.setQueryData(["operations", "updates", "policies"], policies);
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
