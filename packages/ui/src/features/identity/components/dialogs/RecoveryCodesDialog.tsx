import { Button, Modal } from "../../../../index";
export function RecoveryCodesDialog({
    codes,
    onClose,
}: {
    readonly codes: readonly string[];
    readonly onClose: () => void;
}) {
    return (
        <Modal title="Save your recovery codes" onClose={onClose}>
            <p className="mb-4 text-base text-slate-600">
                Each code works once. Save these privately in your password manager. They
                cannot be displayed again.
            </p>
            <ul className="grid gap-2 rounded-lg bg-slate-100 p-4 font-mono text-sm sm:grid-cols-2">
                {codes.map((code) => (
                    <li key={code}>{code}</li>
                ))}
            </ul>
            <Button className="mt-4" onClick={onClose}>
                I saved the codes
            </Button>
        </Modal>
    );
}
