import type { AutomationAccount } from "@homelab/contracts/operations";
import { FieldsForm, Modal } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { TokenLifetime } from "./TokenLifetime";

/**
 * Stage a token replacement with an explicit lifetime, leaving old clients connected.
 * @returns The shared protected form and one-time credential delivery.
 */
export function TokenRotationDialog({
    account,
    onClose,
    onToken,
}: {
    readonly account: AutomationAccount;
    readonly onClose: () => void;
    readonly onToken: (token: string) => void;
}) {
    const [lifetime, setLifetime] = useState<number | null>(90);
    const mutation = useOperation((expiresAt: number | null, signal) =>
        api.automation.rotate.mutate(
            { id: account.id, version: account.version, expiresAt },
            { signal }
        )
    );
    return (
        <Modal
            title="Create replacement token"
            description="The old token stays valid until you update its client and explicitly revoke it."
            onClose={onClose}
            dismissible={!mutation.isPending}
        >
            <FieldsForm
                fields={[]}
                submitLabel="Create token"
                onCancel={onClose}
                onSubmit={async () => {
                    const result = await mutation.mutateAsync(
                        lifetime === null ? null : Date.now() + lifetime * 86_400_000
                    );
                    onToken(result.token);
                }}
            >
                <TokenLifetime value={lifetime} onChange={setLifetime} />
            </FieldsForm>
        </Modal>
    );
}
