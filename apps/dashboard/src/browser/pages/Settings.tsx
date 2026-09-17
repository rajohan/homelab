import { AccountSettings } from "@homelab/ui/identity";

import { AutomationAccess } from "../features/automation/AutomationAccess";
import { useIdentityClient } from "../identity/IdentityClientContext";

/**
 * Render account security settings within the authenticated dashboard.
 * @returns The component's rendered content for its current state.
 */
export function Settings() {
    const client = useIdentityClient();
    return (
        <AccountSettings client={client}>
            <AutomationAccess />
        </AccountSettings>
    );
}
