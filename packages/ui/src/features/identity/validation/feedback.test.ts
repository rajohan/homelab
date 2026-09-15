import { expect, test } from "bun:test";

import type { AccountAction, AccountSection, ConfirmationAction } from "../types";
import { actionSection } from "./actionSection";
import { confirmationCopy } from "./confirmationCopy";
import { confirmationMessage } from "./confirmationMessage";

test("account feedback stays with the action's owning section", () => {
    const actions: ReadonlyArray<readonly [AccountAction, AccountSection]> = [
        ["email", "profile"],
        ["password", "password"],
        ["totp", "authenticators"],
        ["webauthn", "keys"],
        ["recovery", "recovery"],
        [{ kind: "remove", id: "factor", label: "Phone" }, "security"],
        ["all", "sessions"],
        ["others", "sessions"],
        [{ kind: "session", id: "session", label: "Browser" }, "sessions"],
    ];
    for (const [action, section] of actions) expect(actionSection(action)).toBe(section);
});

test("confirmation feedback names the completed operation", () => {
    const actions: ReadonlyArray<readonly [ConfirmationAction, string]> = [
        ["recovery", "Your recovery codes were replaced."],
        ["all", "All sessions were revoked."],
        ["others", "Other sessions were revoked."],
        [
            { kind: "remove", id: "factor", label: "Phone" },
            "The security method was removed.",
        ],
        [
            { kind: "session", id: "session", label: "Browser" },
            "The session was revoked.",
        ],
    ];
    for (const [action, message] of actions)
        expect(confirmationMessage(action)).toBe(message);
});

test("confirmations explain exactly which security access will change", () => {
    const current = confirmationCopy({
        kind: "session",
        id: "current",
        label: "Current",
        current: true,
    });
    expect(current.title).toBe("Log out this browser?");
    expect(current.confirmLabel).toBe("Log out");
    expect(current.description).toContain("other sessions will stay signed in");
    const other = confirmationCopy({
        kind: "session",
        id: "other",
        label: "Other",
        current: false,
    });
    expect(other.confirmLabel).toBe("Revoke session");
    expect(other.description).toContain("current session will stay active");
    expect(confirmationCopy("all").description).toContain("including this browser");
    expect(confirmationCopy("others").description).toContain(
        "This browser will stay signed in"
    );
    expect(confirmationCopy("recovery").description).toContain(
        "existing recovery codes will stop working"
    );
    expect(
        confirmationCopy({ kind: "remove", id: "factor", label: "My key" }).description
    ).toContain('"My key"');
});
