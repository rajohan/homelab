import type { ReactNode } from "react";

import { FieldsForm } from "../Form/FieldsForm";
import { Modal } from "./Modal";

export function ConfirmDialog({
    title,
    children,
    onClose,
    onConfirm,
    confirmLabel = "Confirm",
}: {
    title: string;
    children: ReactNode;
    onClose: () => void;
    onConfirm: () => Promise<void>;
    confirmLabel?: string;
}) {
    return (
        <Modal title={title} onClose={onClose}>
            <div className="mb-4 text-base text-primary-300">{children}</div>
            <FieldsForm fields={[]} submitLabel={confirmLabel} onSubmit={onConfirm} />
        </Modal>
    );
}
