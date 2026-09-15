import { buttonStyles } from "@homelab/ui";
import type { IdentityClient } from "@homelab/ui/identity/client";

import { AccountActions } from "./AccountActions";

/**
 * Offer account navigation when an authenticated user visits auth directly.
 * @returns The signed-in account menu, separate from automatic login handoffs.
 */
export function SignedInActions({
    client,
    username,
    onRefresh,
}: {
    readonly client: IdentityClient;
    readonly username: string | undefined;
    readonly onRefresh: () => Promise<void>;
}) {
    return (
        <div className="space-y-4">
            <p className="text-base">
                Signed in as <strong>{username}</strong>.
            </p>
            <a className={buttonStyles({ fullWidth: true })} href="/dashboard">
                Continue
            </a>
            <AccountActions client={client} onSignedOut={onRefresh} />
        </div>
    );
}
