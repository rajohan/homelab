import { AccountSettings } from "@homelab/ui/identity";
import { IdentityClient } from "@homelab/ui/identity/client";
import { useState } from "react";

export function Settings() {
    const [client] = useState(() => new IdentityClient());
    return <AccountSettings client={client} />;
}
