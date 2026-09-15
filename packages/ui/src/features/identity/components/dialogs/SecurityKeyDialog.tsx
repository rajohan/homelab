import { FieldsForm, Modal } from "../../../../index";
import type { AccountDialogProps } from "../../types";

export function SecurityKeyDialog({
    client,
    onClose,
    onComplete,
    onRecoveryCodes,
}: AccountDialogProps & {
    readonly onRecoveryCodes: (codes: readonly string[]) => void;
}) {
    return (
        <Modal title="Add security key" onClose={onClose}>
            <FieldsForm
                fields={[
                    {
                        name: "label",
                        label: "Key name",
                        placeholder: "e.g. Everyday security key",
                        maximum: 64,
                    },
                ]}
                submitLabel="Register security key"
                onSubmit={async (values) => {
                    const codes = await client.enrollSecurityKey(
                        values.label ?? "Security key"
                    );
                    await onComplete("Your security key was registered.");
                    if (codes.length > 0) onRecoveryCodes(codes);
                }}
            />
        </Modal>
    );
}
