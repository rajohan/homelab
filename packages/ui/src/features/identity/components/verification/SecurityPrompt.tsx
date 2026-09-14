import { useEffect, useSyncExternalStore } from "react";

import { Modal } from "../../../../index";
import type { IdentityClient } from "../../api/IdentityClient";
import { VerificationMethods } from "./VerificationMethods";

export function SecurityPrompt({ client }: { client: IdentityClient }) {
    useEffect(() => () => client.cancelActions(), [client]);
    const open = useSyncExternalStore(
        client.verification.subscribe,
        client.verification.getSnapshot,
        client.verification.getSnapshot
    );
    if (!open) return null;
    return (
        <Modal title="Confirm your identity" onClose={() => client.verification.cancel()}>
            <p className="mb-4 text-base text-slate-600">
                Verify again to continue. Your pending action will resume automatically.
            </p>
            <VerificationMethods
                key={open}
                client={client}
                onVerified={() => client.verification.complete(open)}
            />
        </Modal>
    );
}
