import type { AutomationAccount, Capability } from "@homelab/contracts/operations";
import { FieldsForm, Modal } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { CapabilityPicker } from "./CapabilityPicker";
import { TokenLifetime } from "./TokenLifetime";

/**
 * Create a scoped machine account or edit its permissions using the shared form controls.
 * @returns A cancellation-safe editor with one-time token delivery to its owner.
 */
export function AutomationEditor({
    account,
    onClose,
    onToken,
}: {
    readonly account?: AutomationAccount;
    readonly onClose: () => void;
    readonly onToken: (token: string) => void;
}) {
    const [permissions, setPermissions] = useState<Capability[]>(
        account?.capabilities ?? []
    );
    const [lifetime, setLifetime] = useState<number | null>(90);
    const create = useOperation(
        (
            input: {
                label: string;
                capabilities: Capability[];
                expiresAt: number | null;
            },
            signal
        ) => api.automation.create.mutate(input, { signal })
    );
    const update = useOperation(
        (input: { id: string; version: number; capabilities: Capability[] }, signal) =>
            api.automation.permissions.mutate(input, { signal })
    );
    return (
        <Modal
            title={account ? "Edit automation permissions" : "Create automation account"}
            description="Grant only the permissions this script or service needs. Tokens cannot manage their own access."
            onClose={onClose}
            dismissible={!create.isPending && !update.isPending}
        >
            <FieldsForm
                fields={
                    account
                        ? []
                        : [
                              {
                                  name: "label",
                                  label: "Account name",
                                  placeholder: "For example, OpenClaw",
                                  maximum: 80,
                              },
                          ]
                }
                submitLabel={account ? "Save permissions" : "Create account"}
                onCancel={onClose}
                isSubmitDisabled={() => permissions.length === 0}
                onSubmit={async (values) => {
                    if (account) {
                        await update.mutateAsync({
                            id: account.id,
                            version: account.version,
                            capabilities: permissions,
                        });
                        onClose();
                    } else {
                        const result = await create.mutateAsync({
                            label: values.label ?? "",
                            capabilities: permissions,
                            expiresAt:
                                lifetime === null
                                    ? null
                                    : Date.now() + lifetime * 86_400_000,
                        });
                        onToken(result.token);
                    }
                }}
            >
                <div className="flex flex-col gap-6">
                    <CapabilityPicker value={permissions} onChange={setPermissions} />
                    {!account && (
                        <TokenLifetime value={lifetime} onChange={setLifetime} />
                    )}
                </div>
            </FieldsForm>
        </Modal>
    );
}
