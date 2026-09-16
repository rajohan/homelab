import { expect, mock, test } from "bun:test";

import { render, screen, fireEvent, within } from "@testing-library/react";

import type { AccountSnapshot } from "../../api/schemas";
import { AccountIdentityPanel } from "./AccountIdentityPanel";
import { ApprovedApplicationsPanel } from "./ApprovedApplicationsPanel";
import { AuthenticatorAppsPanel } from "./AuthenticatorAppsPanel";
import { DisableMfaPanel } from "./DisableMfaPanel";
import { ProfilePanel } from "./ProfilePanel";
import { RecoveryCodesPanel } from "./RecoveryCodesPanel";
import { SecurityKeysPanel } from "./SecurityKeysPanel";
import { SessionsPanel } from "./SessionsPanel";

const data: AccountSnapshot = {
    user: {
        id: "fixture",
        username: "operator",
        email: "operator@example.test",
        emailVerified: true,
    },
    sessions: [],
    recoveryCodesRemaining: 8,
    factors: [
        {
            id: "key",
            kind: "webauthn",
            label: "Backup key",
            createdAt: "2026-01-01T00:00:00Z",
            lastUsedAt: null,
        },
        {
            id: "phone",
            kind: "totp",
            label: "Phone",
            createdAt: "2026-01-01T00:00:00Z",
            lastUsedAt: null,
        },
    ],
};
test("keys, authenticator apps and recovery each have their own card and actions", () => {
    const action = mock(() => {});
    render(
        <>
            <SecurityKeysPanel data={data} onAction={action} />
            <AuthenticatorAppsPanel data={data} onAction={action} />
            <RecoveryCodesPanel data={data} onAction={action} />
            <DisableMfaPanel data={data} onAction={action} />
        </>
    );
    expect(screen.getByText("Backup key").closest("#account-keys")).not.toBeNull();
    expect(screen.getByText("Phone").closest("#account-authenticators")).not.toBeNull();
    const count = screen.getByText("8 unused");
    expect(count.closest("#account-recovery")).not.toBeNull();
    expect(count).toHaveClass("text-emerald-300");
    expect(
        screen.getByRole("heading", { name: "Recovery codes" }).parentElement
    ).toContainElement(count);
    for (const [label, id, factorKind] of [
        ["Backup key", "key", "webauthn"],
        ["Phone", "phone", "totp"],
    ] as const) {
        const remove = screen.getByRole("button", { name: `Remove ${label}` });
        expect(remove).toHaveClass("bg-red-700");
        expect(remove.querySelector("svg")).not.toBeNull();
        expect(remove).toHaveTextContent("");
        fireEvent.click(remove);
        expect(action).toHaveBeenCalledWith({ kind: "remove", factorKind, id, label });
    }
    fireEvent.click(screen.getByRole("button", { name: "Disable two-step login" }));
    expect(action).toHaveBeenCalledWith("disable-mfa");
});

test("account identity stays compact and email verification is beside the heading", () => {
    render(
        <>
            <AccountIdentityPanel data={data} onAction={() => {}} />
            <ProfilePanel data={data} onAction={() => {}} />
        </>
    );
    const summary = screen.getByText("Signed in as", { exact: false });
    expect(summary).toHaveTextContent("Signed in as operator.");
    expect(within(summary).getByText("operator").tagName).toBe("STRONG");
    expect(
        screen.queryByRole("heading", { name: "Two-step login" })
    ).not.toBeInTheDocument();
    const verified = screen.getByText("Verified");
    expect(verified).toHaveClass("text-emerald-300");
    expect(
        screen.getByRole("heading", { name: "Account email" }).parentElement
    ).toContainElement(verified);
    expect(screen.getByText(data.user.email)).not.toContainElement(verified);
});

test("empty factor lists use the same bordered surface as registered factors", () => {
    render(
        <>
            <SecurityKeysPanel data={{ ...data, factors: [] }} onAction={() => {}} />
            <AuthenticatorAppsPanel data={{ ...data, factors: [] }} onAction={() => {}} />
        </>
    );
    for (const label of [
        "No security keys registered.",
        "No authenticator apps registered.",
    ])
        expect(screen.getByText(label)).toHaveClass(
            "rounded-lg",
            "border",
            "border-primary-700",
            "bg-primary-900/40"
        );
});

test("unverified email and exhausted recovery codes retain warning states", () => {
    render(
        <>
            <ProfilePanel
                data={{ ...data, user: { ...data.user, emailVerified: false } }}
                onAction={() => {}}
            />
            <RecoveryCodesPanel
                data={{ ...data, recoveryCodesRemaining: 0 }}
                onAction={() => {}}
            />
        </>
    );
    expect(screen.getByText("Unverified")).toHaveClass("text-red-300");
    expect(screen.getByRole("button", { name: "Verify email" })).toBeEnabled();
    expect(screen.getByText("0 unused")).toHaveClass("text-red-300");
});

test("approved applications expose permissions and an app-specific revocation action", () => {
    const action = mock(() => {});
    const view = render(
        <ApprovedApplicationsPanel
            data={{
                ...data,
                applications: [
                    {
                        id: "fixture-client",
                        name: "Fixture app",
                        scopes: ["openid", "profile"],
                        approvedAt: "2026-01-01T12:30:00Z",
                    },
                ],
            }}
            onAction={action}
        />
    );
    try {
        expect(
            screen.getByRole("heading", { name: "Approved applications" })
        ).toBeVisible();
        expect(screen.getByText("Read your name and username")).toBeVisible();
        expect(screen.getByRole("list", { name: "Approved applications" })).toHaveClass(
            "max-h-96",
            "overflow-y-auto",
            "overscroll-contain"
        );
        const button = screen.getByRole("button", { name: "Revoke Fixture app" });
        expect(button.querySelector("svg")).not.toBeNull();
        fireEvent.click(button);
        expect(action).toHaveBeenCalledWith({
            kind: "application",
            id: "fixture-client",
            label: "Fixture app",
        });
    } finally {
        view.unmount();
    }
});

test("session-wide actions share the responsive full-width action group", () => {
    const action = mock(() => {});
    render(<SessionsPanel data={data} onAction={action} />);
    const all = screen.getByRole("button", { name: "Log out all" });
    const others = screen.getByRole("button", { name: "Log out others" });
    expect(all.parentElement).toBe(others.parentElement);
    expect(all.parentElement).toHaveClass(
        "flex-col",
        "[&>button]:w-full",
        "min-[30rem]:flex-row"
    );
    expect(all.parentElement?.lastElementChild).toBe(
        globalThis.matchMedia("(min-width: 30rem)").matches ? all : others
    );
    expect(others).toBeDisabled();
    fireEvent.click(all);
    expect(action).toHaveBeenCalledWith("all");
});

test("the identity card targets only the current session and disables logout without one", () => {
    const onAction = mock(() => {});
    const session = {
        id: "current-browser",
        current: true,
        userAgent: "Test browser",
        createdAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-01T00:00:00Z",
        expiresAt: "2026-01-02T00:00:00Z",
    };
    const view = render(
        <AccountIdentityPanel
            data={{
                ...data,
                sessions: [{ ...session, id: "other-browser", current: false }, session],
            }}
            onAction={onAction}
        />
    );
    const button = screen.getByRole("button", { name: "Log out" });
    expect(button).toBeEnabled();
    expect(button).toHaveClass("shrink-0");
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledWith({
        kind: "session",
        current: true,
        id: session.id,
        label: "your current session",
    });
    view.rerender(<AccountIdentityPanel data={data} onAction={onAction} />);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
});
