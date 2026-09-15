import type { ConfirmationAction } from "../types";

/**
 * Describe the exact destructive action in its confirmation heading.
 * @param action - The factor, session or recovery-code action.
 * @returns The confirmation dialog title.
 */
export function confirmationTitle(action: ConfirmationAction): string {
    if (typeof action === "object")
        return action.kind === "remove"
            ? `Remove ${action.label}?`
            : `Revoke ${action.label}?`;
    if (action === "recovery") return "Replace recovery codes?";
    if (action === "all") return "Revoke all sessions?";
    return "Revoke other sessions?";
}
