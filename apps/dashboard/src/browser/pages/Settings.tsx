import { AccountSettings } from "@homelab/ui/identity";
import { IdentityClient } from "@homelab/ui/identity/client";
import { useState } from "react";

/**
 * Render account security settings within the authenticated dashboard.
 * @returns The component's rendered content for its current state.
 */
export function Settings() {
    const [client] = useState(() => new IdentityClient());
    return <AccountSettings client={client} />;
}
