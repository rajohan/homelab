import { Button, Modal } from "../../../../index";
/**
 * Display newly issued one-use recovery codes until the user confirms saving them.
 * @returns The component's rendered content for its current state.
 */
export function RecoveryCodesDialog({
    codes,
    onClose,
}: {
    readonly codes: readonly string[];
    readonly onClose: () => void;
}) {
    return (
        <Modal title="Save your recovery codes" onClose={onClose}>
            <p className="mb-4 text-base text-primary-300">
                Each code works once. Save these privately in your password manager. They
                cannot be displayed again.
            </p>
            <ul className="grid gap-2 rounded-lg bg-primary-900 p-4 font-mono text-sm sm:grid-cols-2">
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
