import { Button, ErrorNotice } from "@homelab/ui";
import type { IdentityClient } from "@homelab/ui/identity/client";
import { useState } from "react";

import { continueSignIn } from "../navigation/continueSignIn";
export function SignedInActions({
    client,
    address,
    username,
    onRefresh,
}: {
    readonly client: IdentityClient;
    readonly address: URL;
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
            <Button
                disabled={busy}
                onClick={() => {
                    setBusy(true);
                    setFailure(undefined);
                    void continueSignIn(client, address)
                        .catch(setFailure)
                        .finally(() => setBusy(false));
                }}
            >
                {busy ? "Continuing…" : "Continue"}
            </Button>
            <a className="block text-sm text-blue-700 underline" href="/account">
                Manage account security
            </a>
            <Button
                disabled={busy}
                onClick={() => {
                    setBusy(true);
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
