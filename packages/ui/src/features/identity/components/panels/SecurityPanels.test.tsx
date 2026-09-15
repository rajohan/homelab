import { expect, mock, test } from "bun:test";

import { render, screen, fireEvent } from "@testing-library/react";

import type { AccountSnapshot } from "../../api/schemas";
import { AuthenticatorAppsPanel } from "./AuthenticatorAppsPanel";
import { DisableMfaPanel } from "./DisableMfaPanel";
import { RecoveryCodesPanel } from "./RecoveryCodesPanel";
import { SecurityKeysPanel } from "./SecurityKeysPanel";

test("keys, authenticator apps and recovery each have their own card and actions", () => {
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
    expect(screen.getByText("8 unused").closest("#account-recovery")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Disable two-step login" }));
    expect(action).toHaveBeenCalledWith("disable-mfa");
});
