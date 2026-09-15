import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { IdentityClient, IdentityError, type AccountSnapshot } from "../client";
import { AccountSettings } from "./AccountSettings";

const snapshot: AccountSnapshot = {
    user: {
        id: "user",
        username: "operator",
        email: "operator@example.test",
        emailVerified: true,
    },
    factors: [],
    recoveryCodesRemaining: 0,
    events: [],
    sessions: [
        {
            id: "session",
            userAgent: "Test browser",
            current: true,
            createdAt: "2026-01-01T00:00:00Z",
            lastSeenAt: "2026-01-01T00:00:00Z",
            expiresAt: "2026-01-02T00:00:00Z",
        },
    ],
};
const cleanups: Array<() => void> = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
});
function renderSettings() {
    const client = new IdentityClient();
    client.bindIdentity("user:session");
    const read = spyOn(client, "snapshot").mockResolvedValue(snapshot);
    let fresh = false;
    const request = spyOn(client, "request").mockImplementation((path) => {
        if (path === "/api/session")
            return Promise.resolve({
                authenticated: true,
                mfaRequired: false,
                methods: [],
            });
        if (path === "/api/account/proof/password") {
            fresh = true;
            return Promise.resolve({ ok: true });
        }
        if (path === "/api/account/email" && !fresh)
            return Promise.reject(
                new IdentityError("STEP_UP_REQUIRED", 403, "Verify again.")
            );
        return Promise.resolve({ ok: true });
    });
    const query = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
        <QueryClientProvider client={query}>
            <AccountSettings client={client} />
        </QueryClientProvider>
    );
    cleanups.push(() => {
        client.cancelActions();
        query.clear();
        request.mockRestore();
        read.mockRestore();
    });
    return { client, request };
}
describe("account security modal", () => {
    test("preserves the email form, verifies in a modal and replays the original action", async () => {
        const user = userEvent.setup();
        const { request } = renderSettings();
        await user.click(await screen.findByRole("button", { name: "Change email" }));
        const email = screen.getByLabelText("Email address");
        await user.clear(email);
        await user.type(email, "replacement@example.test");
        await user.click(screen.getByRole("button", { name: "Send verification email" }));
        const prompt = await screen.findByRole("dialog", {
            name: "Confirm your identity",
        });
        await user.type(
            within(prompt).getByLabelText("Current password"),
            "test-password-only"
        );
        await user.click(within(prompt).getByRole("button", { name: "Verify password" }));
        const notice = await screen.findByText(
            "Check your inbox for a verification link."
        );
        expect(notice).toBeVisible();
        expect(notice.closest("#account-profile")).not.toBeNull();
        expect(notice.closest("#account-security")).toBeNull();
        const mutations = request.mock.calls.filter(
            ([path]) => path === "/api/account/email"
        );
        expect(mutations).toHaveLength(2);
        expect(mutations[0]?.[1]).toEqual({ email: "replacement@example.test" });
        expect(mutations[1]?.[1]).toEqual(mutations[0]?.[1]);
    });
    test("closing the verification modal does not apply the change or discard form input", async () => {
        const user = userEvent.setup();
        const { request } = renderSettings();
        await user.click(await screen.findByRole("button", { name: "Change email" }));
        await user.clear(screen.getByLabelText("Email address"));
        await user.type(screen.getByLabelText("Email address"), "kept@example.test");
        await user.click(screen.getByRole("button", { name: "Send verification email" }));
        const prompt = await screen.findByRole("dialog", {
            name: "Confirm your identity",
        });
        await user.click(within(prompt).getByRole("button", { name: "Close dialog" }));
        await waitFor(() =>
            expect(
                screen.queryByRole("dialog", { name: "Confirm your identity" })
            ).not.toBeInTheDocument()
        );
        expect(screen.getByLabelText("Email address")).toHaveValue("kept@example.test");
        expect(
            request.mock.calls.filter(([path]) => path === "/api/account/email")
        ).toHaveLength(1);
        expect(screen.getByText("Security verification was cancelled.")).toBeVisible();
    });
});
