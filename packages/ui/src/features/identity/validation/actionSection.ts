import type { AccountAction, AccountSection } from "../types";

/**
 * Place action feedback beside the account section that initiated it.
 * @param action - The pending account action.
 * @returns The owning profile, sessions or security section.
 */
export function actionSection(action: AccountAction): AccountSection {
    if (action === "email") return "profile";
    if (action === "password" || action === "recovery") return action;
    if (action === "totp") return "authenticators";
    if (action === "webauthn") return "keys";
    if (
        action === "others" ||
        action === "all" ||
        (typeof action === "object" && action.kind === "session")
    )
        return "sessions";
    return "security";
}
