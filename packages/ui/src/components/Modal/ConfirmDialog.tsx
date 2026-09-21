import { useState, type ReactNode } from "react";

import { ErrorNotice } from "../Alert/ErrorNotice";
import { ActionGroup } from "../Button/ActionGroup";
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
    children,
    confirmDisabled = false,
    size = "md",
}: {
    title: string;
    description: string;
    onClose: () => void;
    onConfirm: () => Promise<void>;
    confirmLabel?: string;
    variant?: ButtonVariant;
    children?: ReactNode;
    confirmDisabled?: boolean;
    size?: "md" | "wide";
}) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>();
    return (
        <Modal
            title={title}
            description={description}
            onClose={onClose}
            dismissible={!pending}
            size={size}
        >
            <Form
                className="space-y-4"
                onSubmit={async () => {
                    if (pending || confirmDisabled) return;
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
                {children}
                {error !== undefined && <ErrorNotice error={error} />}
                <ActionGroup>
                    <Button
                        type="submit"
                        variant={variant}
                        busy={pending}
                        disabled={confirmDisabled}
                    >
                        {confirmLabel}
                    </Button>
                    <Button
                        variant="secondary"
                        onClick={onClose}
                        disabled={pending}
                        data-autofocus
                    >
                        Cancel
                    </Button>
                </ActionGroup>
            </Form>
        </Modal>
    );
}
