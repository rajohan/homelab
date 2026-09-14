import type { IdentityClient } from "@homelab/ui/identity/client";
export interface AuthPageProps {
    readonly client: IdentityClient;
    readonly address: URL;
    readonly token: string | null;
}
