import { expect, test } from "bun:test";

import type { AccountAction, AccountSection, ConfirmationAction } from "../types";
import { actionSection } from "./actionSection";
import { confirmationMessage } from "./confirmationMessage";

test("account feedback stays with the action's owning section", () => {
    const actions: ReadonlyArray<readonly [AccountAction, AccountSection]> = [
        ["email", "profile"],
        ["password", "profile"],
        ["totp", "security"],
        ["webauthn", "security"],
        ["recovery", "security"],
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
