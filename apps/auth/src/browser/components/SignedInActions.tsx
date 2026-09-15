import { Button, ErrorNotice, buttonStyles } from "@homelab/ui";
import type { IdentityClient } from "@homelab/ui/identity/client";
import { useState } from "react";

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
    const [failure, setFailure] = useState<unknown>();
    const [busy, setBusy] = useState(false);
    return (
        <div className="space-y-4">
            {failure !== undefined && <ErrorNotice error={failure} />}
            <p className="text-base">
                Signed in as <strong>{username}</strong>.
            </p>
            <a className={buttonStyles({ fullWidth: true })} href="/dashboard">
                Continue
            </a>
            <a className="block text-sm text-accent-300 underline" href="/account">
                Manage account security
            </a>
            <Button
                busy={busy}
                variant="secondary"
                fullWidth
                onClick={() => {
                    setBusy(true);
                    setFailure(undefined);
                    void client
                        .request("/api/logout", {})
                        .then(onRefresh)
                        .catch(setFailure)
                        .finally(() => setBusy(false));
                }}
            >
                Use another account
            </Button>
        </div>
    );
}
