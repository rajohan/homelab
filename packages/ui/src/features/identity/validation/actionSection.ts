import type { AccountAction, AccountSection } from "../types";

export function actionSection(action: AccountAction): AccountSection {
    if (action === "email" || action === "password") return "profile";
    if (
        action === "others" ||
        action === "all" ||
        (typeof action === "object" && action.kind === "session")
    )
        return "sessions";
    return "security";
}
