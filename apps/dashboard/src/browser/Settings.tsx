import { AccountSettings } from "@homelab/identity-ui";
import { IdentityClient } from "@homelab/identity-ui/client";
import { useState } from "react";

export function Settings() {
    const [client] = useState(() => new IdentityClient());
    return <AccountSettings client={client} />;
}
