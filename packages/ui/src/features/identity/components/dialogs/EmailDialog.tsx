import { FieldsForm, Modal } from "../../../../index";
import type { AccountDialogProps } from "../../types";

export function EmailDialog({
    client,
    onClose,
    onComplete,
    email,
}: AccountDialogProps & { readonly email: string }) {
    return (
        <Modal title="Verify email" onClose={onClose}>
            <p className="mb-4 text-base text-primary-300">
                Your current address stays active until you confirm the new address using
                the emailed link.
            </p>
            <FieldsForm
                fields={[
                    {
                        name: "email",
                        placeholder: "you@example.com",
                        label: "Email address",
                        type: "email",
                        autoComplete: "email",
                        initial: email,
                        maximum: 254,
                    },
                ]}
                submitLabel="Send verification email"
                onSubmit={async (values) => {
                    await client.action("email", { email: values.email });
                    await onComplete("A verification link has been queued for delivery.");
                }}
            />
        </Modal>
    );
}
