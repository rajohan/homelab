import { expect, spyOn, test } from "bun:test";

import { act, screen, waitFor } from "@testing-library/react";

import type * as AuthEntry from "../apps/auth/src/browser/main";
import type * as DashboardEntry from "../apps/dashboard/src/browser/main";

test("the auth entry mounts the sign-in screen and strips proof fragments from browser history", async () => {
    const originalFetch = globalThis.fetch;
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    globalThis.history.replaceState(null, "", "/sign-in#token=synthetic-proof");
    globalThis.fetch = Object.assign(
        () =>
            Promise.resolve(
                Response.json({ authenticated: false, mfaRequired: false, methods: [] })
            ),
        { preconnect: originalFetch.preconnect }
    );
    let entry: typeof AuthEntry | undefined;
    try {
        await act(async () => {
            entry = await import("../apps/auth/src/browser/main");
        });
        await waitFor(() =>
            expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy()
        );
        expect(globalThis.location.hash).toBe("");
        expect(screen.getByLabelText("Username")).toBeTruthy();
    } finally {
        act(() => entry?.applicationRoot.unmount());
        globalThis.fetch = originalFetch;
        root.remove();
    }
});

test("the dashboard entry mounts its unauthenticated boundary without exposing account settings", async () => {
    const originalFetch = globalThis.fetch;
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    globalThis.history.replaceState(null, "", "/account");
    const navigate = spyOn(globalThis.location, "replace").mockImplementation(() => {});
    globalThis.fetch = Object.assign(
        () =>
            Promise.resolve(
                Response.json({ authenticated: false, mfaRequired: false, methods: [] })
            ),
        { preconnect: originalFetch.preconnect }
    );
    let entry: typeof DashboardEntry | undefined;
    try {
        await act(async () => {
            entry = await import("../apps/dashboard/src/browser/main");
        });
        await waitFor(() =>
            expect(navigate).toHaveBeenCalledWith("/login?returnTo=%2Faccount")
        );
        expect(screen.queryByRole("heading", { name: "Account settings" })).toBeNull();
    } finally {
        act(() => entry?.applicationRoot.unmount());
        globalThis.fetch = originalFetch;
        root.remove();
        navigate.mockRestore();
    }
});
