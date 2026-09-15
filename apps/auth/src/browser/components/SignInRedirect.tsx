import { Button, ErrorNotice, LoadingState, Redirect } from "@homelab/ui";
import type { IdentityClient } from "@homelab/ui/identity/client";
import { useEffect, useRef, useState } from "react";

import { signInDestination } from "../navigation/signInDestination";

/**
 * Complete a verified sign-in without presenting an additional confirmation screen.
 * @returns Navigation progress or a retryable handoff error.
 */
export function SignInRedirect({
    client,
    address,
}: {
    client: IdentityClient;
    address: URL;
}) {
    const pending = useRef<Promise<string> | undefined>(undefined);
    const [attempt, setAttempt] = useState(0);
    const [destination, setDestination] = useState<string>();
    const [failure, setFailure] = useState<unknown>();
    useEffect(() => {
        // React may replay effects; one mounted handoff must only submit once.
        pending.current ??= signInDestination(client, address);
        let active = true;
        void pending.current.then(
            (target) => {
                if (active) setDestination(target);
                return target;
            },
            (error: unknown) => {
                if (active) setFailure(error);
            }
        );
        return () => {
            active = false;
        };
    }, [client, address, attempt]);

    if (destination) return <Redirect to={destination} label="Completing sign-in…" />;
    if (failure !== undefined)
        return (
            <div className="space-y-4">
                <ErrorNotice error={failure} />
                <Button
                    fullWidth
                    onClick={() => {
                        pending.current = undefined;
                        setFailure(undefined);
                        setAttempt(attempt + 1);
                    }}
                >
                    Try again
                </Button>
            </div>
        );
    return <LoadingState label="Completing sign-in…" />;
}
