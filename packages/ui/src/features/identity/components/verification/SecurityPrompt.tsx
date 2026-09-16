import { useEffect, useSyncExternalStore } from "react";

import { Modal } from "../../../../index";
import type { IdentityClient } from "../../api/IdentityClient";
import { VerificationMethods } from "./VerificationMethods";

/**
 * Show the shared step-up dialog and cancel pending actions when it is dismissed.
 * @returns The component's rendered content for its current state.
 */
export function SecurityPrompt({ client }: { client: IdentityClient }) {
    useEffect(() => () => client.cancelActions(), [client]);
    const open = useSyncExternalStore(
        client.verification.subscribe,
        client.verification.getSnapshot,
        client.verification.getSnapshot
    );
    if (!open) return null;
    return (
        <Modal
            title="Confirm your identity"
            description="For your security, verify again to make this change. Your action will continue automatically."
            onClose={() => client.cancelActions()}
        >
            <VerificationMethods
                key={open}
                client={client}
                onVerified={() => client.verification.complete(open)}
            />
        </Modal>
    );
}
