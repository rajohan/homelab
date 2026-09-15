import type { ConfirmationAction } from "../types";

/**
 * Select success feedback for a completed confirmation action.
 * @param action - The successfully completed action.
 * @returns The action-specific success message.
 */
export function confirmationMessage(action: ConfirmationAction): string {
    if (typeof action === "object")
        return action.kind === "remove"
            ? "The security method was removed."
            : "The session was revoked.";
    switch (action) {
        case "recovery": {
            return "Your recovery codes were replaced.";
        }
        case "all": {
            return "All sessions were revoked.";
        }
        case "others": {
            return "Other sessions were revoked.";
        }
    }
}
