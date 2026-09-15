import type { ConfirmationAction } from "../types";

/**
 * Describe the consequence and action label for an account security confirmation.
 * @param action - The factor, session or recovery-code operation.
 * @returns Copy that distinguishes this browser from other signed-in sessions.
 */
export function confirmationCopy(action: ConfirmationAction): {
    title: string;
    description: string;
    confirmLabel: string;
} {
    if (typeof action === "object") {
        if (action.kind === "remove")
            return {
                title: "Remove security method?",
                description: `You will no longer be able to use "${action.label}" to verify your identity. Keep another security method or your recovery codes available.`,
                confirmLabel: "Remove security method",
            };
        if (action.current)
            return {
                title: "Log out this browser?",
                description:
                    "You will be signed out. Your other sessions will stay signed in.",
                confirmLabel: "Log out",
            };
        return {
            title: "Revoke this session?",
            description:
                "This browser session will be signed out and will need to sign in again. Your current session will stay active.",
            confirmLabel: "Revoke session",
        };
    }
    if (action === "recovery")
        return {
            title: "Replace recovery codes?",
            description:
                "Your existing recovery codes will stop working. Save the new codes in your password manager before closing the next window.",
            confirmLabel: "Replace recovery codes",
        };
    if (action === "all")
        return {
            title: "Log out all sessions?",
            description:
                "You will be signed out everywhere, including this browser. Connected applications will receive a logout notification where supported.",
            confirmLabel: "Log out everywhere",
        };
    return {
        title: "Log out other sessions?",
        description:
            "All other sessions will be signed out. This browser will stay signed in.",
        confirmLabel: "Log out other sessions",
    };
}
