import { useState } from "react";

import { ErrorNotice } from "../Alert/ErrorNotice";
import { Button } from "../Button/Button";
import type { ButtonVariant } from "../Button/buttonStyles";
import { Form } from "../Form/Form";
import { Modal } from "./Modal";

/**
 * Confirm an action with explicit cancel/submit controls and operation-local feedback.
 * @returns The focus-managed confirmation dialog.
 */
export function ConfirmDialog({
    title,
    description,
    onClose,
    onConfirm,
    confirmLabel = "Confirm",
    variant = "danger",
}: {
    title: string;
    description: string;
    onClose: () => void;
    onConfirm: () => Promise<void>;
    confirmLabel?: string;
    variant?: ButtonVariant;
}) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    return (
        <Modal
            title={title}
            description={description}
            onClose={onClose}
            dismissible={!pending}
        >
            <Form
                className="space-y-4"
                onSubmit={async () => {
                    if (pending) return;
                    setPending(true);
                    setError(undefined);
                    try {
                        await onConfirm();
                    } catch (error) {
                        setError(error);
                    } finally {
                        setPending(false);
                    }
                }}
            >
                {error !== undefined && <ErrorNotice error={error} />}
                <div className="flex flex-wrap justify-end gap-2">
                    <Button
                        variant="secondary"
                        onClick={onClose}
                        disabled={pending}
                        data-autofocus
                    >
                        Cancel
                    </Button>
                    <Button type="submit" variant={variant} busy={pending}>
                        {confirmLabel}
                    </Button>
                </div>
            </Form>
        </Modal>
    );
}
