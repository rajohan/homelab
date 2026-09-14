import type { ConfirmationAction } from "../types";

export function confirmationTitle(action: ConfirmationAction): string {
    if (typeof action === "object")
        return action.kind === "remove"
            ? `Remove ${action.label}?`
            : `Revoke ${action.label}?`;
    if (action === "recovery") return "Replace recovery codes?";
    if (action === "all") return "Revoke all sessions?";
    return "Revoke other sessions?";
}
