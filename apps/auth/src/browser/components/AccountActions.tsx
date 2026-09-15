import { Button, ErrorNotice } from "@homelab/ui";
import type { IdentityClient } from "@homelab/ui/identity/client";
import { useState } from "react";

/**
 * Offer account switching without discarding a pending handoff.
 * @returns Shared actions for direct auth visits and recoverable handoff failures.
 */
export function AccountActions({
    client,
    onSignedOut,
}: {
    client: IdentityClient;
    onSignedOut: () => Promise<void>;
}) {
    const [failure, setFailure] = useState<unknown>();
    const [busy, setBusy] = useState(false);
    return (
        <div className="space-y-4">
            {failure !== undefined && <ErrorNotice error={failure} />}
            <Button
                busy={busy}
                variant="secondary"
                fullWidth
                onClick={() => {
                    setBusy(true);
                    setFailure(undefined);
                    void client
                        .request("/api/logout", {})
                        .then(onSignedOut)
                        .catch(setFailure)
                        .finally(() => setBusy(false));
                }}
            >
                Use another account
            </Button>
        </div>
    );
}
